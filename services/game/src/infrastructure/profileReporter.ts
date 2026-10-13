import { callJson, config } from '@sw/kit';
import type { MatchReporter } from '../application/match';

/** Sends finished matches to the profile service. */
export class HttpMatchReporter implements MatchReporter {
  async report(result: Parameters<MatchReporter['report']>[0]) {
    await callJson(`${config.urls.profile}/matches`, { body: result, headers: { 'x-internal-key': config.internalKey } });
  }
}
