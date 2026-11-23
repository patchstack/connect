// Turns a scored attempt into findings: one JSON object per line in findings.jsonl, in the format the
// README describes under "Findings". A reviewer, or a later aggregation step, merges them across runs by
// `signature`; nothing here files anything anywhere.
// Evidence paths are relative to the attempt directory.
import { writeFileSync } from 'node:fs';
import path from 'node:path';

// Checks that measure what the agent did with Connect's output, as opposed to what Connect did.
const AGENT_CHECKS = new Set(['claimUrlSurfaced', 'summaryPassedOn', 'devScriptsPreserved', 'sandboxNotPersisted', 'noProductionLeak']);

/** The text of one numbered report section ("3. HESITATIONS …") up to the next numbered heading. */
export function reportSection(report, name) {
  const match = report.match(new RegExp(`^\\s*(?:#+\\s*)?\\d+\\.\\s*\\**${name}\\b[^\\n]*\\n([\\s\\S]*?)(?=^\\s*(?:#+\\s*)?\\d+\\.\\s*\\**[A-Z][A-Z ]+\\b|$(?![\\s\\S]))`, 'm'));
  return match?.[1].trim() ?? '';
}

/**
 * Write findings.jsonl for one attempt and return the findings.
 * `context`: { template, appClass, persona, verdict, agentOutput, cliCommands, roundDir }.
 */
export function writeFindings({ template, appClass, persona, verdict, agentOutput, cliCommands, roundDir }) {
  const evidence = (...files) => files; // relative to the attempt directory, so results can be moved
  const commands = cliCommands.map((command) => `npx ${command.args.join(' ')} → exit ${command.status}`);
  const findings = [];

  for (const [name, check] of Object.entries(verdict.checks)) {
    if (check.pass || check.notApplicable) continue;
    findings.push({
      signature: `check:${name}:${template}`,
      title: `${name} failed on ${template}`,
      stage: 'install',
      check: name,
      type: 'bug',
      owner: AGENT_CHECKS.has(name) ? 'prompt' : 'connect',
      app_class: appClass,
      template,
      persona,
      actual: check.detail,
      commands,
      evidence: evidence('scorecard.json', 'report.md', 'cli'),
    });
  }

  // What the agent itself says slowed it down or confused it. Unstructured, so it is passed on as quoted
  // text for a person to read rather than scored.
  for (const [section, type] of [['HESITATIONS', 'agent-hesitation'], ['UX FRICTION', 'ux-friction']]) {
    const text = reportSection(agentOutput, section);
    if (text === '' || /^(?:none|n\/a|nothing)\.?$/i.test(text)) continue;
    findings.push({
      signature: `report:${type}:${template}:${persona}`,
      title: `${section.toLowerCase()} reported on ${template}`,
      stage: 'install',
      type,
      owner: null,
      app_class: appClass,
      template,
      persona,
      actual: text,
      evidence: evidence('report.md'),
    });
  }

  writeFileSync(path.join(roundDir, 'findings.jsonl'), findings.map((finding) => JSON.stringify(finding)).join('\n') + (findings.length ? '\n' : ''));
  return findings;
}
