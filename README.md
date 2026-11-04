# gcal-auto-invite

A small Google Apps Script that adds a fixed list of extra email addresses as
attendees to your upcoming Google Calendar events. Handy for mirroring your
calendar to a second address.

## Behavior

- Looks at events on your primary calendar from now until `lookaheadDays` days
  ahead (default 90), following every page of results.
- Only touches regular events (`eventType` of `default`); birthdays,
  Gmail-derived events, focus time and similar are skipped.
- Skips events whose attendee list exists but is empty.
- Patches in only the addresses that are missing (compared case-insensitively),
  keeping existing attendees.
- For a recurring event, the invitees are added to the whole series once, so
  every instance (including future ones) gets them. A single instance is only
  patched on its own when its series already has the invitees.
- Events you only attend are updated when the organizer lets guests invite
  others (Google's default) or modify the event. Otherwise, and when Google
  omits part of the guest list, they are skipped and logged, since patching a
  partial list could drop guests.
- If an event cannot be updated (for example one you may not modify), the run
  carries on with the rest and then fails, so Apps Script reports it.
- Overlapping runs are skipped.

By default Google does not email the invitees about the change (`sendUpdates` is
`"none"`); set it to `"all"` to send invitations.

## Setup

Deploys with [clasp](https://github.com/google/clasp) (Node 20+). Each Google
account gets its own folder under `accounts/`, with its own settings, script and
login, so you can run this for as many accounts as you like. The examples use
the name `work`; any name works, including an email address.

1. Install and create the account's config:

   ```bash
   npm install
   mkdir accounts/work
   cp accounts/example/config.json accounts/work/config.json
   ```

   Edit `accounts/work/config.json`:

   ```json
   {
     "invitees": ["other@example.org"],
     "title": "gcal-auto-invite"
   }
   ```

   `invitees` are the addresses to add to your events. Optional keys:
   `everyHours` (how often it runs), `lookaheadDays`, `sendUpdates` and
   `timeZone` (for example `"America/Los_Angeles"`, default UTC). The defaults
   and allowed values are in `src/Code.gs`.

2. Turn on the Apps Script API for that Google account at
   <https://script.google.com/home/usersettings>.

3. Sign in, create the script and upload it:

   ```bash
   npm run gas -- work login
   npm run gas -- work create
   npm run gas -- work push
   ```

   `login` opens a browser, so sign in with the matching Google account.

4. Open the editor, pick `installTrigger` and click Run:

   ```bash
   npm run gas -- work open-script
   ```

   This grants Calendar access and schedules `addOtherEmailInvites`. Google
   offers no API for creating triggers, so this one manual run per account is
   needed. It is safe to run again; it replaces the earlier trigger. After
   changing `everyHours`, run `push` and then `installTrigger` again.

Other commands work the same way: `npm run gas -- <name> tail-logs`, `status`,
`create-deployment`, and so on. `login` and `logout` only manage credentials and
need no config.

- Every other command first builds `accounts/<name>/build/` from `src/`, adding
  a generated `Config.gs` with that account's settings. `title` only applies
  when `create` runs; it does not rename an existing script.
- `accounts/*` is gitignored except `accounts/example`, so addresses and script
  IDs stay out of git.
- Logins are kept by clasp in `~/.clasprc.json`, one per name.
- To use an existing script instead of `create`, write
  `accounts/<name>/.clasp.json` as `{"scriptId": "<id>", "rootDir": "build"}`.

## Development

```bash
npm test               # runs src/Code.gs against mocked Apps Script services
npm run format         # prettier, 80 columns
npm run format:check
```

The manifest pins the OAuth scopes to `calendar.events` and `script.scriptapp`.

## Changelog

- Multiple invitees are supported.
- Event filtering uses an allowlist (`eventType` `default`) instead of a
  denylist.

## License

MIT, see [LICENSE](LICENSE).
