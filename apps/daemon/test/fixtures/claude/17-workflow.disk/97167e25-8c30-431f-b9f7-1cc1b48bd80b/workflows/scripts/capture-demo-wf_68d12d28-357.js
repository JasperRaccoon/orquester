export const meta = {
  name: 'capture-demo',
  description: 'Two-phase capture demo',
  phases: [{ title: 'Gather', detail: 'two words in parallel' }, { title: 'Combine', detail: 'join them' }],
}
phase('Gather')
const words = await parallel(['alpha', 'beta'].map(w => () =>
  agent('Reply with exactly the single word ' + w + ' and nothing else. Do not use any tools.', { label: 'gather:' + w, phase: 'Gather', effort: 'low' })))
phase('Combine')
const joined = await agent('Reply with exactly this text and nothing else: ' + words.filter(Boolean).join(' ') + ' done. Do not use any tools.', { label: 'combine', phase: 'Combine', effort: 'low' })
return { joined }