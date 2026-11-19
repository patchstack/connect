import { readFileSync } from 'node:fs';
import { ACTIVATION_HEADER, activationChallenge, verifyActivationResponse } from './protect/activation.js';
import { readBuildStamp } from './build-id.js';
import { findRulesFile } from './build-stamp.js';
import { safeRemoteUrl } from './endpoint-policy.js';
import { readBoundedText } from './bounded-response.js';
import type { Config } from './types.js';

export interface ActivationResult { ok: boolean; message: string; summary?: string }

export async function probeActivation(target: string, secret: string, signal: AbortSignal): Promise<Record<string, unknown> | null> {
  const challenge = await activationChallenge(secret, target);
  const response = await fetch(target, {
    method: 'OPTIONS', redirect: 'error', signal, headers: { [ACTIVATION_HEADER]: challenge },
  });
  const body = await readBoundedText(response, 16_384);
  return response.ok ? verifyActivationResponse(secret, challenge, body, response.headers.get(ACTIVATION_HEADER)) : null;
}

/** Inspect only an explicitly selected running URL. Never discover ports, start, or restart an app. */
export async function checkActivation(url: string, config: Config, cwd: string, expectedBuildId?: string | null): Promise<ActivationResult> {
  const target = safeRemoteUrl(url);
  if (!target || new URL(target).hash) return {ok:false,message:'Activation URL must use HTTPS (or loopback HTTP), without credentials or a fragment.'};
  const secret = config.pulseAuth || config.apiKey;
  if (!secret || !config.siteUuid) return {ok:false,message:'Activation check needs this site identity and its server-side credential.'};
  if (expectedBuildId === undefined) {
    const file = findRulesFile(cwd);
    try { expectedBuildId = file.kind === 'one' ? readBuildStamp(JSON.parse(readFileSync(file.path,'utf8'))) : null; }
    catch { expectedBuildId = null; }
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const work = async (): Promise<ActivationResult> => {
      const status = await probeActivation(target, secret, controller.signal);
      if (!status || status.siteUuid !== config.siteUuid) return {ok:false,message:'The selected URL did not prove activation for this site. Check the server credential, guard integration and deployed package version.'};
      if (!expectedBuildId || status.buildId !== expectedBuildId) return {ok:false,message:'The guard answered, but its loaded map is absent or different. Let the framework reload, or restart/rebuild/deploy, then check again.'};
      const readiness = ['ready','pending'].includes(String(status.mapRules)) ? status.mapRules : 'unknown';
      const rules = status.rules as {request?:number;response?:number;egress?:number;delivered?:number;local?:number;scopedBlocking?:number} | undefined;
      const source = status.source as {ok?:boolean;origin?:string} | undefined;
      const split = `${Number(rules?.request ?? 0)} request / ${Number(rules?.response ?? 0)} response`;
      const plural = (count: number) => `${count} ${count === 1 ? 'rule' : 'rules'}`;
      const fetchedFromPatchstack = source?.origin === 'api' || source?.origin === 'cache';
      const counts = typeof rules?.delivered === 'number' && typeof rules.local === 'number'
        ? `${plural(rules.delivered)} ${fetchedFromPatchstack ? 'from Patchstack' : 'from its bundled rules file'} + ${rules.local} of the guard's own (${split} / ${Number(rules.egress ?? 0)} outgoing)`
        : `${split} rules`;
      const age = typeof status.lastCheckedAt === 'number' ? ` (${Math.max(0,Math.floor((Date.now()-status.lastCheckedAt)/1000))}s since last success)` : '';
      return {
        ok:true,
        message:`Guard active at the checked URL with the current map; rule readiness ${readiness}; server map match ${status.matched === true ? 'confirmed' : 'unconfirmed'}; last rule lookup ${source?.ok === true ? 'successful' : 'unconfirmed'}${age}; ${counts}; ${Number(rules?.scopedBlocking ?? 0)} rules for this app's own routes in blocking mode${status.devSync ? ' (HMR detect-only hold)' : ''}. This does not prove coverage of other routes or exploit blocking.`,
        summary:`Protection answered at the checked URL with the current app map. Rules: ${readiness}; map match: ${status.matched === true ? 'confirmed' : 'unconfirmed'}; latest rule check: ${source?.ok === true ? 'successful' : 'unconfirmed'}${age}.${status.devSync ? ' Rules for specific inputs only report attacks during hot reload.' : ''} This does not prove blocking or protection on other URLs.`,
      };
    };
    const timeout = new Promise<ActivationResult>(resolve => { timer = setTimeout(() => { controller.abort(); resolve({ok:false,message:'Activation check timed out; the running app was not changed.'}); },5000); });
    return await Promise.race([work(),timeout]);
  } catch {
    return {ok:false,message:'Activation check could not reach and verify the selected URL. Redirects are not followed; the running app was not changed.'};
  } finally { clearTimeout(timer); }
}
