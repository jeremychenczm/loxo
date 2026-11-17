import { apiFetch } from './api';

export const VENDORS = ['anthropic', 'openai'] as const;
export type Vendor = (typeof VENDORS)[number];

export interface ProviderView {
  id: string;
  name: string;
  vendor: Vendor;
  apiKeyPrefix: string;
  baseUrl: string | null;
  models: string[];
  isDefault: boolean;
}

export interface PlatformHealth {
  platform: string;
  label: string;
  vendor: string;
  cli: { available: boolean; version: string; error?: string };
  credentials: { providerCount: number; envConfigured: boolean };
  ready: boolean;
  installHint: string;
}

export interface ProviderInput {
  name: string;
  vendor: Vendor;
  apiKey?: string;
  baseUrl?: string | null;
  models?: string[];
  isDefault?: boolean;
}

export const fetchProviders = () =>
  apiFetch<{ providers: ProviderView[] }>('/api/providers').then((r) => r.providers);

export const fetchRuntimeHealth = () =>
  apiFetch<{ health: { checkedAt: string; platforms: PlatformHealth[] } }>(
    '/api/providers/runtime-health'
  ).then((r) => r.health);

export const createProvider = (input: ProviderInput & { apiKey: string }) =>
  apiFetch<{ provider: ProviderView }>('/api/providers', {
    method: 'POST',
    body: JSON.stringify(input),
  }).then((r) => r.provider);

export const updateProvider = (id: string, input: Partial<ProviderInput>) =>
  apiFetch<{ provider: ProviderView }>(`/api/providers/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  }).then((r) => r.provider);

export const deleteProvider = (id: string) =>
  apiFetch<{ ok: boolean }>(`/api/providers/${id}`, { method: 'DELETE' });
