import type { Env } from './env'
import { translateStructured } from './translationStructure'
import {
  translationConfig,
  translationRequest,
  parseTranslation,
  type TranslationConfig,
  type TranslationInput as ProviderInput,
} from './translationProvider'

const LANGUAGES = ['zh', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'ru', 'pt', 'it', 'ar']
export type Translator = 'ai' | 'deepl' | 'microsoft' | 'baidu' | 'youdao' | 'tencent' | 'openai'
export interface TranslationInput {
  text: string
  source: string
  target: string
  provider: Translator
  settings?: TranslationConfig
}
export function translators(env: Env): Translator[] {
  return [
    ...(env.AI ? ['ai' as const] : []),
    ...(env.DEEPL_API_KEY ? ['deepl' as const] : []),
    ...(env.MICROSOFT_TRANSLATOR_KEY ? ['microsoft' as const] : []),
    ...(['baidu', 'youdao', 'tencent', 'openai'] as const).filter(
      (p) => !!env.SERVICE_CREDENTIALS?.[p]?.key,
    ),
  ]
}
export function translationInput(raw: unknown): TranslationInput | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  const { text, source, target } = value
  const provider = value.provider ?? 'ai'
  if (
    typeof text !== 'string' ||
    !text.trim() ||
    text.length > 2000 ||
    typeof source !== 'string' ||
    (source !== 'auto' && !LANGUAGES.includes(source)) ||
    typeof target !== 'string' ||
    !LANGUAGES.includes(target) ||
    typeof provider !== 'string' ||
    !['ai', 'deepl', 'microsoft', 'baidu', 'youdao', 'tencent', 'openai'].includes(provider) ||
    (provider === 'ai' && source === 'auto')
  )
    return null
  return {
    text,
    source,
    target,
    provider: provider as Translator,
    ...(value.settings && typeof value.settings === 'object'
      ? { settings: translationConfig(value.settings as Record<string, unknown>) }
      : {}),
  }
}
export async function translate(env: Env, input: TranslationInput, signal: AbortSignal) {
  const timed = AbortSignal.any([signal, AbortSignal.timeout(25000)])
  return translateStructured(
    input.text,
    (text, signal) => translateLine(env, { ...input, text }, signal),
    timed,
  )
}
async function translateLine(env: Env, input: TranslationInput, signal: AbortSignal) {
  signal.throwIfAborted()
  let text: unknown, detected: unknown
  if (input.provider === 'ai') {
    // The binding has no cancellation API; bound waiting time and discard late results.
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const response = await Promise.race([
        env.AI!.run('@cf/meta/m2m100-1.2b', {
          text: input.text,
          source_lang: input.source,
          target_lang: input.target,
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), 25000)
        }),
      ])
      text = (response as { translated_text?: string }).translated_text
    } finally {
      clearTimeout(timer)
    }
  } else {
    const provider = input.provider
    const saved = env.SERVICE_CREDENTIALS?.[provider] ?? {}
    const key =
      saved.key ||
      (provider === 'deepl'
        ? env.DEEPL_API_KEY
        : provider === 'microsoft'
          ? env.MICROSOFT_TRANSLATOR_KEY
          : '') ||
      ''
    const config =
      input.settings ??
      translationConfig({
        deeplFree: key.endsWith(':fx'),
        microsoftRegion: saved.region || env.MICROSOFT_TRANSLATOR_REGION,
        tencentRegion: saved.region || 'ap-guangzhou',
        baseUrl: saved.endpoint?.replace(/\/chat\/completions$/, ''),
        model: saved.model,
      })
    const request = await translationRequest(provider, input as ProviderInput, config, {
      id: saved.id ?? '',
      key,
      endpoint: saved.endpoint,
    })
    const response = await fetch(request.url, { ...request.init, signal })
    if (!response.ok) throw new Error('upstream')
    const result = parseTranslation(provider, await response.json())
    text = result.text
    detected = result.detected
  }
  signal.throwIfAborted()
  if (typeof text !== 'string' || !text.trim() || text.length > 100000) throw new Error('upstream')
  return { text, ...(typeof detected === 'string' ? { detected } : {}) }
}
