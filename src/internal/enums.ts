import type { AccountStatus, ChangeReason } from '../types'

const ACCOUNT_STATUSES: readonly AccountStatus[] = [
  'available',
  'noAccount',
  'restricted',
  'temporarilyUnavailable',
  'couldNotDetermine',
]

const CHANGE_REASONS: readonly ChangeReason[] = [
  'serverChange',
  'initialSync',
  'quotaViolation',
  'accountChange',
  'unknown',
]

/**
 * Codegen has no string-union type, so enums cross the bridge as plain strings.
 * Validate on the way in rather than casting - an unrecognised value from a
 * newer native build should degrade to a known-safe member, not corrupt an
 * exhaustive switch downstream.
 */
export function toAccountStatus(raw: string): AccountStatus {
  return (ACCOUNT_STATUSES as readonly string[]).includes(raw)
    ? (raw as AccountStatus)
    : 'couldNotDetermine'
}

export function toChangeReason(raw: string): ChangeReason {
  return (CHANGE_REASONS as readonly string[]).includes(raw)
    ? (raw as ChangeReason)
    : 'unknown'
}
