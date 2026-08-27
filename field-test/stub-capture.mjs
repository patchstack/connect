// A scripted "agent" that records the prompt it was given and does nothing else.
//
// The harness sends the composed persona on stdin, so this is the only vantage point that sees exactly
// what the agent under test sees. Reasoning about the composition is not the same check: the leak this
// guards against was a `readFileSync` reaching stdin unmodified, and only reading stdin can prove it does
// not.
//
// Writes to $PS_CAPTURE_STDIN. Produces no report, so the round scores as a refusal — which is expected
// and irrelevant: this stub exists to capture the input, not to exercise the flow.
import { writeFileSync } from 'node:fs';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const target = process.env.PS_CAPTURE_STDIN;
  if (!target) {
    console.error('PS_CAPTURE_STDIN is not set; nothing captured.');
    process.exit(2);
  }
  writeFileSync(target, input);
  console.log('captured');
});
