# Maestro tests for the example app

UI tests for the example app, driven by [Maestro](https://maestro.dev). They exercise every
tab's real interactive surface - typing into fields, tapping every button, and reading back
what the app logs - against a real booted simulator/emulator.

## Running

```sh
# From the repo root, with a simulator/emulator booted and the example app installed:
maestro test example/.maestro                       # everything
maestro test example/.maestro/flows/faults.yaml      # one flow
maestro test example/.maestro --include-tags=local   # skip the flows that need a real account/token
```

If more than one simulator is booted, pass `--udid <id>` (`maestro --udid <id> test ...`) -
otherwise Maestro's device auto-detection can pick the wrong one (e.g. a paired Apple Watch
simulator).

On iOS, the very first run on a simulator installs Maestro's XCTest driver, which can take
longer than the CLI's default startup timeout. If you see `iOS driver not ready in time`, set
`MAESTRO_DRIVER_STARTUP_TIMEOUT=180000` (ms) and retry.

## What's covered

- `smoke.yaml` - app launches, chrome and the first tab render.
- `navigation.yaml` - every tab (including the "More" overflow sheet) shows the right screen.
- `faults.yaml`, `store.yaml` - fully local/deterministic (in-memory providers, no account or
  network needed), so these assert the actual result, not just that a tap happened.
- `icloud-kv.yaml`, `cloudkit.yaml`, `drive.yaml`, `sync-demo.yaml` - talk to real
  icloudKV/CloudKit/Drive providers. Success there depends on the test device's signed-in
  iCloud account / a real Drive token, so most assertions only check that a tap produced its
  synchronous log line ("· <label>"), not that the call itself succeeded - that line is a
  substring of both the immediate info line and the eventual result line, so it's timing-safe
  either way. `cloudkit.yaml`'s oversized-write check is an exception: the 1 MB cap is enforced
  locally before any network call, so it's deterministic everywhere.
- `files.yaml` - local file generation (no account/network needed either).

## Maestro/iOS quirks these flows work around

- **`text` selectors are a full-string regex match, not a substring search.** Expected
  fragments are wrapped `.*like this.*` to match anywhere in the target's full text - which,
  for a log line, includes a timestamp prefix the assertion doesn't know in advance. Regex
  metacharacters in the expected text (`( ) [ ] { }`) are escaped.
- **An off-screen element isn't in the accessibility tree at all on iOS**, so neither `tapOn`
  nor `assertVisible` can find or scroll to one on its own. Every screen's Log section sits
  below the fold, so flows explicitly `scrollUntilVisible` down to it before asserting, and
  back up (centered, to the specific button being tapped next) before the next tap.
- **Tapping a button that was just found via `tapOn: { id: ... }` matches by testID**, not by
  label text - several buttons share visible text with either another button on the same
  screen (`remove` vs `removeItem`) or with the log line their own tap produces (`getItem` the
  button vs `getItem` the log entry), which would otherwise be an ambiguous match.
- Occasionally a tap right after a scroll or a keyboard dismiss lands while the view is still
  settling and is silently a no-op even though Maestro reports it as completed. The riskiest of
  those spots are wrapped in a `retry:` block.
