/**
 * Integration tests for Stellar RPC endpoint failover (#1152)
 *
 * StellarRpcClient is tested in isolation with mocked Soroban.Server
 * instances so no real network traffic is produced.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StellarRpcClient } from '../../services/StellarRpcClient';

// Mock the Soroban.Server constructor so we can control per-endpoint behaviour
vi.mock('@stellar/stellar-sdk', async () => {
    const actual = await vi.importActual('@stellar/stellar-sdk') as any;
    return {
        ...actual,
        rpc: {
            ...actual.rpc,
            Server: vi.fn(),
        },
    };
});

import { rpc as Soroban } from '@stellar/stellar-sdk';

const ENDPOINTS = [
    'https://rpc-primary.example',
    'https://rpc-secondary.example',
    'https://rpc-tertiary.example',
];

function makeServer(impl: (method: string) => Promise<unknown>) {
    return new Proxy({}, {
        get: (_t, method: string) => (...args: unknown[]) => impl(method),
    }) as unknown as Soroban.Server;
}

describe('StellarRpcClient – RPC failover', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('calls the primary endpoint on success', async () => {
        let calledUrl = '';
        (Soroban.Server as unknown as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
            calledUrl = url;
            return makeServer(async () => ({ ledger: 1 }));
        });

        const client = new StellarRpcClient(ENDPOINTS);
        const result = await client.call((s) => (s as any).getLatestLedger());

        expect(result).toEqual({ ledger: 1 });
        expect(calledUrl).toBe(ENDPOINTS[0]);
    });

    it('fails over to the secondary endpoint when the primary errors', async () => {
        const urlsUsed: string[] = [];
        (Soroban.Server as unknown as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
            urlsUsed.push(url);
            if (url === ENDPOINTS[0]) {
                return makeServer(async () => { throw new Error('network error'); });
            }
            return makeServer(async () => ({ ledger: 2 }));
        });

        const client = new StellarRpcClient(ENDPOINTS);
        const result = await client.call((s) => (s as any).getLatestLedger());

        expect(result).toEqual({ ledger: 2 });
        expect(urlsUsed[0]).toBe(ENDPOINTS[0]);
        expect(urlsUsed[1]).toBe(ENDPOINTS[1]);
    });

    it('fails over through all endpoints and succeeds on the last', async () => {
        const urlsUsed: string[] = [];
        (Soroban.Server as unknown as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
            urlsUsed.push(url);
            if (url !== ENDPOINTS[2]) {
                return makeServer(async () => { throw new Error('timeout'); });
            }
            return makeServer(async () => ({ ledger: 3 }));
        });

        const client = new StellarRpcClient(ENDPOINTS);
        const result = await client.call((s) => (s as any).getLatestLedger());

        expect(result).toEqual({ ledger: 3 });
        expect(urlsUsed).toHaveLength(3);
    });

    it('throws when all endpoints fail', async () => {
        (Soroban.Server as unknown as ReturnType<typeof vi.fn>).mockImplementation(() =>
            makeServer(async () => { throw new Error('all down'); }),
        );

        const client = new StellarRpcClient(ENDPOINTS);
        await expect(client.call((s) => (s as any).getLatestLedger())).rejects.toThrow('all down');
    });

    it('does not fail over on non-retryable errors (e.g. bad request)', async () => {
        const urlsUsed: string[] = [];
        (Soroban.Server as unknown as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
            urlsUsed.push(url);
            return makeServer(async () => {
                const err = new Error('Bad request') as any;
                err.status = 400;
                throw err;
            });
        });

        const client = new StellarRpcClient(ENDPOINTS);
        await expect(client.call((s) => (s as any).getLatestLedger())).rejects.toThrow('Bad request');
        // Should have tried only the first endpoint
        expect(urlsUsed).toHaveLength(1);
    });

    it('marks a failing endpoint as unhealthy and prefers healthy ones', async () => {
        const urlsUsed: string[] = [];
        (Soroban.Server as unknown as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
            urlsUsed.push(url);
            if (url === ENDPOINTS[0]) {
                return makeServer(async () => { throw new Error('network error'); });
            }
            return makeServer(async () => ({ ledger: 4 }));
        });

        const client = new StellarRpcClient(ENDPOINTS);

        // First call: primary fails → secondary succeeds
        await client.call((s) => (s as any).getLatestLedger());
        urlsUsed.length = 0;

        // Second call: primary is now unhealthy → should start with secondary
        await client.call((s) => (s as any).getLatestLedger());

        expect(urlsUsed[0]).toBe(ENDPOINTS[1]);
    });

    it('reports endpoint health correctly', async () => {
        (Soroban.Server as unknown as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
            if (url === ENDPOINTS[0]) {
                return makeServer(async () => { throw new Error('network error'); });
            }
            return makeServer(async () => ({ ledger: 5 }));
        });

        const client = new StellarRpcClient(ENDPOINTS);
        await client.call((s) => (s as any).getLatestLedger());

        const health = client.getHealth();
        expect(health.find((h) => h.url === ENDPOINTS[0])?.healthy).toBe(false);
        expect(health.find((h) => h.url === ENDPOINTS[1])?.healthy).toBe(true);
    });

    it('fails over on 429 rate-limit responses', async () => {
        const urlsUsed: string[] = [];
        (Soroban.Server as unknown as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
            urlsUsed.push(url);
            if (url === ENDPOINTS[0]) {
                return makeServer(async () => {
                    const err = new Error('Too Many Requests') as any;
                    err.status = 429;
                    throw err;
                });
            }
            return makeServer(async () => ({ ledger: 6 }));
        });

        const client = new StellarRpcClient(ENDPOINTS);
        const result = await client.call((s) => (s as any).getLatestLedger());

        expect(result).toEqual({ ledger: 6 });
        expect(urlsUsed[0]).toBe(ENDPOINTS[0]);
        expect(urlsUsed[1]).toBe(ENDPOINTS[1]);
    });

    it('fails over on 503 service-unavailable responses', async () => {
        const urlsUsed: string[] = [];
        (Soroban.Server as unknown as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
            urlsUsed.push(url);
            if (url === ENDPOINTS[0]) {
                return makeServer(async () => {
                    const err = new Error('Service Unavailable') as any;
                    err.status = 503;
                    throw err;
                });
            }
            return makeServer(async () => ({ ledger: 7 }));
        });

        const client = new StellarRpcClient(ENDPOINTS);
        await client.call((s) => (s as any).getLatestLedger());

        expect(urlsUsed[0]).toBe(ENDPOINTS[0]);
        expect(urlsUsed[1]).toBe(ENDPOINTS[1]);
    });
});
