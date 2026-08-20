import type { ResolveCandidate, ResolveFn } from './types'

/**
 * Resolves by a numeric timestamp inside a JSON value.
 *
 * The common shape by far: values are JSON objects carrying `updatedAt` (or
 * similar), and the newest wins. Candidates that are not JSON, or that lack the
 * field, lose to any that have it - a value you cannot date is not evidence
 * against one you can.
 *
 * ```ts
 * createCloudStore({
 *   providers: ['icloudKV', 'googleDrive'],
 *   writeMode: 'mirror',
 *   resolve: resolveByTimestamp('updatedAt'),
 * })
 * ```
 */
export function resolveByTimestamp(field = 'updatedAt'): ResolveFn {
  return (candidates: ResolveCandidate[]): string | null => {
    if (candidates.length === 0) return null

    let best: ResolveCandidate | null = null
    let bestAt = Number.NEGATIVE_INFINITY

    for (const candidate of candidates) {
      const at = timestampOf(candidate.value, field)
      // Strictly greater, so an earlier provider wins a tie - which keeps the
      // result stable rather than flapping between equal copies.
      if (at > bestAt) {
        best = candidate
        bestAt = at
      }
    }

    // Nothing was datable: fall back to preference order rather than guessing.
    if (best == null) return candidates[0].value
    return best.value
  }
}

function timestampOf(value: string, field: string): number {
  try {
    const parsed: unknown = JSON.parse(value)
    if (parsed == null || typeof parsed !== 'object') return Number.NEGATIVE_INFINITY
    const raw = (parsed as Record<string, unknown>)[field]
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw
    // ISO strings are just as common as epoch millis.
    if (typeof raw === 'string') {
      const parsedDate = Date.parse(raw)
      if (!Number.isNaN(parsedDate)) return parsedDate
    }
    return Number.NEGATIVE_INFINITY
  }
  catch {
    return Number.NEGATIVE_INFINITY
  }
}

/** Always takes the first provider that has a value. The default behaviour. */
export const resolveByPreferenceOrder: ResolveFn = candidates =>
  candidates.length > 0 ? candidates[0].value : null

/**
 * Resolves by the *server's* last-modified time rather than a timestamp inside
 * the value.
 *
 * {@link resolveByTimestamp} requires every value to be JSON carrying a field
 * the app remembered to update - a real constraint, and one that silently fails
 * open the day someone writes a plain string or forgets to bump `updatedAt`.
 * Both CloudKit (`modified.timestamp`) and Drive (`modifiedTime`) already
 * report a modification time, one query parameter away, so this orders on that
 * instead and works on payloads the app never had to instrument.
 *
 * The catch, and the reason this is not the default: `NSUbiquitousKeyValueStore`
 * exposes no per-key timestamp at all, so an `icloudKV` candidate never carries
 * one. Pass `fallback` to say what should happen then - by default an undated
 * candidate loses to any dated one, and preference order breaks a tie among
 * undated ones.
 *
 * ```ts
 * createCloudStore({
 *   providers: ['cloudKit', 'googleDrive'],   // both report server time
 *   writeMode: 'mirror',
 *   resolve: resolveByModifiedAt(),
 * })
 * ```
 */
export function resolveByModifiedAt(
  options: { fallback?: ResolveFn } = {}
): ResolveFn {
  const fallback = options.fallback ?? resolveByPreferenceOrder

  return (candidates: ResolveCandidate[]): string | null => {
    if (candidates.length === 0) return null

    const dated = candidates.filter(
      (c): c is ResolveCandidate & { modifiedAt: number } =>
        typeof c.modifiedAt === 'number' && Number.isFinite(c.modifiedAt)
    )

    // Nothing reported a server time - every candidate came from a provider
    // that does not track one. Guessing here would be worse than deferring.
    if (dated.length === 0) return fallback(candidates)

    let best = dated[0]
    // Strictly greater, so an earlier provider wins a tie and the result stays
    // stable rather than flapping between equal copies.
    for (const candidate of dated) if (candidate.modifiedAt > best.modifiedAt) best = candidate

    return best.value
  }
}

/**
 * Tries each resolver in turn and takes the first non-null answer.
 *
 * The practical combination for a mixed fleet: server time where the provider
 * reports it, an embedded timestamp where it does not.
 *
 * ```ts
 * resolveFirstOf(resolveByModifiedAt(), resolveByTimestamp('updatedAt'))
 * ```
 */
export function resolveFirstOf(...resolvers: ResolveFn[]): ResolveFn {
  return (candidates: ResolveCandidate[]): string | null => {
    for (const resolve of resolvers) {
      const answer = resolve(candidates)
      if (answer != null) return answer
    }
    return null
  }
}
