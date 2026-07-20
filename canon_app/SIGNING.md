# Signing and notarizing Strategi Canon

Everything in the build works today except the one step nobody but you can do:
getting a certificate from Apple. This file is the runbook for that step and the
commands that follow it.

## What "unsigned" actually costs you

The build already produces a **valid** signature. It is *ad-hoc*, which means
"correctly signed, with no identity behind it". That is enough for the app to
run, and it is what keeps the bundle from reading as damaged. It is **not**
enough for Gatekeeper:

```
$ spctl -a -t exec -vv "dist/Strategi Canon.app"
dist/Strategi Canon.app: rejected
```

So every recipient gets the right-click > Open dance the first time, exactly as
`SETUP.md` describes. Nothing is broken; it just looks alarming to a
non-technical person opening it.

A Developer ID certificate plus notarization removes the warning entirely. That
is the only thing it buys. Weigh it against $99/year: for a handful of internal
teammates the ad-hoc build is genuinely fine, and the instructions in SETUP.md
cover it. For anyone outside the team, pay for the certificate.

## Step 1: enrol (only you can do this)

Apple Developer Program, **$99 USD per year**, verified 2026-07-20 from
<https://developer.apple.com/support/compare-memberships/>. Developer ID
certificates for distributing Mac apps outside the App Store are included.

**Plan the lead time.** Enrolling as an organization requires a **D-U-N-S
Number registered to the legal entity** (Apple's stated requirement on the page
above). If Strategi does not already have one, request it before anything else:
that lookup/registration is the slow part, not the Apple form. Enrolling as an
individual skips D-U-N-S but puts the certificate in a personal name, which is
worth deciding deliberately rather than by accident.

## Step 2: create and install the certificate

1. In Xcode: **Settings > Accounts**, add the Apple ID, select the team.
2. **Manage Certificates > + > Developer ID Application**.
3. Confirm it landed in the keychain:

```bash
security find-identity -v -p codesigning
# want a line reading: "Developer ID Application: <NAME> (<TEAMID>)"
```

Until that command lists an identity, the build falls back to ad-hoc and says so.

## Step 3: store notary credentials once

Notarization needs an App Store Connect API key (preferred) or an
app-specific password. Store it in the keychain under the profile name the build
script prints:

```bash
xcrun notarytool store-credentials canon-notary \
    --apple-id "you@strategi.is" \
    --team-id "TEAMID" \
    --password "app-specific-password"
```

## Step 4: build, notarize, staple

```bash
CODESIGN_IDENTITY='Developer ID Application: NAME (TEAMID)' ./build-mac.sh

ditto -c -k --keepParent "dist/Strategi Canon.app" dist/StrategiCanon.zip
xcrun notarytool submit dist/StrategiCanon.zip --keychain-profile canon-notary --wait
xcrun stapler staple "dist/Strategi Canon.app"

# the check that actually matters: should say "accepted", not "rejected"
spctl -a -t exec -vv "dist/Strategi Canon.app"
```

Ship the **stapled** `.app` (re-zip it after stapling). Stapling attaches the
notarization ticket to the bundle so it validates even on a machine that is
offline the first time it runs.

## What the build already handles for you

You should not need to touch these; they are recorded so the next person does
not undo them.

- **Signing happens last.** Both the `LSUIElement` plist stamp and the runtime
  copy mutate the bundle, and either one after signing invalidates it. macOS
  treats a *broken* signature worse than an absent one: the app reads as
  "damaged" and right-click > Open does not clear it.
- **Inside-out signing.** Nested Mach-O binaries under `Resources/runtimes` are
  signed before the bundle. `--deep` is deliberately not used: it applies the
  outer bundle's entitlements to nested code, and the notary service rejects
  that.
- **`entitlements.plist`** grants three things the bundled runtimes need under
  the hardened runtime. Each has a comment explaining which runtime needs it and
  what breaks without it. Dropping one yields a build that notarizes and then
  fails to launch, which is the worst possible failure mode.
- **The stdlib is precompiled before sealing.** CPython writes `__pycache__`
  next to any stdlib module it imports without a fresh `.pyc`. Inside a signed
  bundle those are unsealed additions, so the app would invalidate its own
  signature on first run, on the recipient's machine. Precompiling means the
  `.pyc` files exist and get sealed.

Regression check after any change to the build:

```bash
codesign --verify --strict --deep "dist/Strategi Canon.app"; echo "exit=$?"   # want 0
"dist/Strategi Canon.app/Contents/Resources/runtimes/python/bin/python3" -c "import ssl"
codesign --verify --strict --deep "dist/Strategi Canon.app"; echo "exit=$?"   # want 0 AGAIN
```

The second check is the one that catches the `__pycache__` class of bug: the
seal must survive the runtimes actually being used.

## Windows

The `.exe` is unsigned and SmartScreen warns accordingly. Removing that needs an
**Authenticode** certificate from a commercial CA (DigiCert, Sectigo, and
others), which is a separate purchase from the Apple one. An OV certificate
still accumulates SmartScreen reputation over time; an EV certificate carries
reputation immediately. If Windows recipients are a small internal group, the
"More info > Run anyway" path in SETUP.md is the pragmatic choice.

Once you have a certificate, sign after the PyInstaller step:

```bat
signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 ^
    /f cert.pfx /p PASSWORD "dist\Strategi Canon\Strategi Canon.exe"
```
