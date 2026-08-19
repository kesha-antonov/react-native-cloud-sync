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
