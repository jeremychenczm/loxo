import { ProxyAgent, setGlobalDispatcher } from 'undici';

/**
 * Node's fetch ignores HTTP(S)_PROXY by default, unlike browsers and curl.
 * Behind a corporate or regional proxy that breaks every provider call
 * (OpenAI/Anthropic) with a bare "fetch failed". Honoring the standard
 * env vars keeps egress working wherever the host shell already does.
 */
export function configureEgressProxy(): void {
  const proxy =
    process.env.HTTPS_PROXY ??
    process.env.https_proxy ??
    process.env.HTTP_PROXY ??
    process.env.http_proxy;
  if (!proxy) return;

  try {
    setGlobalDispatcher(new ProxyAgent(proxy));
    console.log(`Outbound fetch routed through proxy ${proxy}`);
  } catch (error) {
    console.error(`Invalid proxy URL "${proxy}":`, error);
  }
}
