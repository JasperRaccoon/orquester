export const meta = {
  name: 'capture-stop',
  description: 'Workflow stopped mid-run',
  phases: [{ title: 'Slow' }],
}
phase('Slow')
await parallel([1, 2].map(i => () =>
  agent('Run this exact Bash command and then reply with the word finished: sleep 240', { label: 'slow:' + i, phase: 'Slow', effort: 'low' })))
return 'unreachable'