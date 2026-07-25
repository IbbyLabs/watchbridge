# Privacy

This describes what the hosted Watchbridge instance at **watchbridge.ibbylabs.dev**
does with your data. If you run your own copy, you are the operator and this does
not apply to you — though it is a fair description of what the software does
either way.

Operator and data controller: **IbbyLabs** (<https://ibbylabs.dev>).

## What is collected

**Because you have an account**

- Email address — to sign you in, confirm the address, and reset a password.
- Username, if you set one.
- A hash of your password. The password itself is never stored.
- Sign-in sessions, each with the IP address and browser user-agent that created
  it, so you can be signed out and abuse can be traced.

**Because you connected a service**

- Access and refresh tokens, or API keys, for the accounts you connect (Trakt,
  Simkl, PublicMetaDB, MDBList). These are encrypted before storage.
- The watch history, playback progress, ratings and watchlist entries those
  services expose. This is the data that is synced between them.

**Because you run syncs**

- Your sync configurations, and a record of each run and its outcome, so you can
  see what happened and diagnose failures.

Nothing is collected for advertising, and there is no analytics or tracking.

## How it is protected

- Connection tokens and API keys are encrypted at rest with AES-256-GCM.
- All traffic is served over HTTPS.
- Passwords are hashed with argon2id and never stored in the clear.
- Provider credentials are never written to logs or included in a data export.

## Who it is shared with

- No one. Your data is not sold, rented, or shared with third parties.
- Watch data is sent only to the providers you explicitly connect and sync, as
  the direction of each sync you set up requires.

## Your control

- Download everything held for your account as a JSON file from Settings.
- Disconnect any provider at any time, which removes its stored credentials.
- Request account deletion by contacting the operator (see below), which removes
  your account and all associated data.

## Contact

Reach the operator on Discord: <https://discord.gg/wPY2pcqjmm>, or by direct
message to `@ibbys89`.

## Changes

Material changes to this policy will be noted in the repository history.
