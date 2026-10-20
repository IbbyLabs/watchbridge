# Privacy

This describes what the hosted Watchbridge instance at **watchbridge.ibbylabs.dev**
does with your data. If you run your own copy, you are the operator and this does
not apply to you, though it is a fair description of what the software does
either way.

Operator and data controller: **IbbyLabs** (<https://ibbylabs.dev>), based in the
United Kingdom. Contact: **team@ibbylabs.dev**.

## What is collected, and why

**Because you have an account**

- Email address, to sign you in, confirm the address, reset a password, and send
  sync alerts you have turned on.
- Username, if you set one.
- A hash of your password. The password itself is never stored.
- Sign-in sessions, each with the IP address and browser user-agent that created
  it, so you can see and end your sessions and so abuse can be traced.

**Because you connected a service**

- Access and refresh tokens, or API keys, for the accounts you connect (Trakt,
  Simkl, PublicMetaDB, MDBList). These are encrypted before storage.
- The watch history, playback progress, ratings and watchlist entries those
  services expose. This is the data that is synced between them.

**Because you run syncs**

- Your sync configurations, a record of each run and its outcome, and a record
  of items already delivered to each target so they are not sent twice.

Nothing is collected for advertising, and there is no analytics or tracking. The
only cookie is the sign-in session cookie, which the service needs to work.

## Legal basis

- Running your account and your syncs: **contract**. We need this data to provide
  the service you signed up for.
- Keeping the IP address and user-agent of each session: **legitimate
  interests**, in keeping accounts secure and tracing abuse.

## How long it is kept

- Sign-in sessions last 30 days and are deleted 7 days after they expire or as
  soon as you sign out.
- Sync run records are deleted after 90 days.
- Email confirmation and password reset links expire within 24 hours and are then
  deleted.
- Everything else is kept while your account exists. Deleting your account
  deletes all of it straight away. Backups that contain it are encrypted and
  deleted within 8 days.

## Who processes it for us

Your data is not sold, rented, or shared for anyone else's use. These services
handle it on our behalf, only to run Watchbridge:

- **A cloud provider in the UK (London)**, which hosts the servers and database.
- **Cloudflare**, which sits in front of the site and handles all traffic,
  including your IP address, and stores our encrypted backups.
- **Resend**, which sends account and alert emails, so it receives your email
  address.

Watch data is also sent to the providers you connect, as the direction of each
sync you set up requires. Their own privacy policies apply to what they hold.

## Transfers outside the UK

Cloudflare and Resend are based in the United States, so some data is processed
there. Both are certified under the UK Extension to the EU-US Data Privacy Framework,
which these transfers rely on. Where that does not apply, each provider's data
processing terms use the EU Standard Contractual Clauses with the UK Addendum.

## How it is protected

- Connection tokens and API keys are encrypted at rest with AES-256-GCM.
- All traffic is served over HTTPS.
- Passwords are hashed with argon2id and never stored in the clear.
- Session and email link tokens are stored only as hashes.
- Provider credentials are never written to logs or included in a data export.

## Your rights

Under UK data protection law you can ask to access, correct or delete your data,
to restrict or object to how it is used, and to receive it in a portable format.

- **Download** everything held for your account as a JSON file from Settings.
- **Delete** your account from Settings. This removes your account and all
  associated data immediately.
- **Disconnect** any provider at any time, which removes its stored credentials.
- For anything else, email **team@ibbylabs.dev**. We answer within one month.

If you are unhappy with how your data is handled, you can complain to the
Information Commissioner's Office at <https://ico.org.uk/make-a-complaint/>.
We would appreciate the chance to fix it first.

## Changes

Material changes to this policy will be noted in the repository history, and
the date below updated.

Last updated: 20 October 2026.
