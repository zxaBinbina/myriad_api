/** Mirrored in myriad_api: repositories must remain independently deployable. */
export async function translateStructured(
  source: string,
  translate: (text: string, signal: AbortSignal) => Promise<{ text: string; detected?: string }>,
  signal: AbortSignal,
) {
  signal.throwIfAborted()
  const lines = source.split(/(\r\n|\n|\r)/)
  const jobs: { index: number; prefix: string; text: string; suffix: string }[] = []
  let fence = ''
  for (let index = 0; index < lines.length; index += 2) {
    const line = lines[index]!
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]
    if (marker) {
      if (!fence) fence = marker
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = ''
      continue
    }
    if (fence || !line.trim() || /^\s*(?:[-*_]\s*){3,}$/.test(line)) continue
    // Keep indentation, quote/heading/list/checklist markers outside the translator.
    const prefix = /^(?:[ \t]*> ?)*[ \t]*(?:(?:#{1,6}|[-+*]|\d+[.)])\s+)?(?:\[[ xX]\]\s+)?/.exec(
      line,
    )![0]
    const suffix = /[ \t]*$/.exec(line)![0]
    const text = line.slice(prefix.length, line.length - suffix.length)
    if (text) jobs.push({ index, prefix, text, suffix })
  }
  const ctrl = new AbortController()
  const combined = AbortSignal.any([signal, ctrl.signal])
  let next = 0
  let detected: string | undefined
  async function work() {
    while (next < jobs.length) {
      combined.throwIfAborted()
      const job = jobs[next++]!
      try {
        const result = await translate(job.text, combined)
        combined.throwIfAborted()
        if (!result.text.trim()) throw new Error('upstream')
        // Services may invent line breaks; each segment maps to exactly one source line.
        lines[job.index] = job.prefix + result.text.trim().replace(/[\r\n]+/g, ' ') + job.suffix
        detected ??= result.detected
      } catch (error) {
        ctrl.abort()
        throw error
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, jobs.length) }, work))
  signal.throwIfAborted()
  return { text: lines.join(''), ...(detected ? { detected } : {}) }
}
