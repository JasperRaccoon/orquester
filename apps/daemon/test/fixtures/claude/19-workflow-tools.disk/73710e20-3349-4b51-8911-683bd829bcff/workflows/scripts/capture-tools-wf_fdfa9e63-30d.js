export const meta = {
  name: 'capture-tools',
  description: 'One agent that uses a tool',
  phases: [{ title: 'Read' }],
}
phase('Read')
const word = await agent('Use the Read tool to read a.txt in the current directory, then reply with only its first word.', { label: 'read:a', phase: 'Read', effort: 'low' })
return word