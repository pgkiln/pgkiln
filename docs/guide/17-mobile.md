# 17. Mobile and field work: Progressive Web Apps

Field crews, drivers and warehouse staff work on phones, often with a bad connection or none.
Any pgapex application can become a **Progressive Web App** (APEX: Progressive Web App): installed on
the home screen with its own icon, full screen, and working on when the network drops.

## Turning it on

**App → Settings → Progressive Web App**:

| Setting | What it does |
|---|---|
| Installable | Adds a web app manifest and a service worker to the application. Phones offer "Add to home screen" / "Install"; the app then opens full screen, without the browser bar |
| Name under the icon | The short name on the home screen (the application's name when empty) |
| Keep visited pages on the device | Pages a user opened are shown again when there is no connection (with a notice that they may be out of date) |
| Keep forms sent without a connection | Forms submitted offline are kept on the device and sent when the connection is back |
| Icon | A square PNG of at least 512 × 512 pixels. Without one, the app gets a tile with its initial in the theme's accent colour |

Installing needs HTTPS in production (any address except `localhost` / `127.0.0.1`); pgapex behind
a TLS proxy ([chapter 1](01-installation.md)) is enough.

Everything is per application, under its own address: `/a/<alias>/manifest.webmanifest`,
`/a/<alias>/sw.js` (the service worker, which only handles that application's pages),
`/a/<alias>/icon-192.png`, `/a/<alias>/icon-512.png` and `/a/<alias>/offline`.

## Offline

- **The app shell** (pgapex's CSS, script and icons) and an offline page are stored when the app is
  installed, so the app always opens.
- **Pages** are fetched from the network first. Without a connection, a page the user opened before
  comes from the device (when *Keep visited pages* is on); otherwise the offline page appears,
  listing the pages that are on the device.
- Kept pages contain the user's data. They stay on the device only while the user is signed in:
  signing in or out removes them, so the next person on a shared device doesn't see them.
- Live data (reports, charts) is as fresh as the last visit. Actions that need the server (searching,
  downloads, dynamic actions) wait for the connection.

## Forms sent offline

With *Keep forms sent without a connection* on, a form submitted while the network is down (or
drops halfway) is not lost:

1. The service worker keeps the form, **files and photos included**, on the device and shows the page
   again with the notice *Saved on this device*. A panel at the bottom shows how many forms are
   waiting, with *Send now* and *Discard*.
2. When the connection is back (or the app is opened again), the forms are sent in order, **only for
   the user who filled them in**, with a fresh CSRF token. If the session has ended, the panel asks
   the user to sign in first.
3. The server processes each form at most once: every page form carries a **submission id**, and a
   form that arrives again (a lost response, a double tap) is acknowledged without running its
   processes again.
4. Each form also carries the key of the record it was opened for, signed by the server, so a form
   sent later updates *that* record even if the user opened other records in the meantime.
5. A form the server refuses (a validation error) stays in the panel as *rejected*: open the page and
   correct it.

Validations, processes and row level security run when the form arrives, as for any submission.

## Field items

| Item | For | Setting |
|---|---|---|
| **Location** (`location`) | The device's position: a *Use my location* button fills in `latitude,longitude` (5 decimals, about 1 m). Read-only, it shows a map link. The server checks the format | item type `location` |
| **Photo from the camera** | File items open the camera on phones | `{"capture": "environment"}` (the back camera) or `"user"` |
| **Smaller photos** | Photos are scaled down (JPEG) on the phone before they are uploaded: much less mobile data and faster forms | `{"max_px": 1600}` (the longest side) |
| **Barcode / QR code scan** | A *Scan* button on a text item reads a code with the camera (parcels, pallets, assets). It appears only where the browser can read codes (`BarcodeDetector`, e.g. Chrome on Android) | `{"scan": true}` on a text item |

The page's `Permissions-Policy` allows the camera and the position for the application itself and
nothing else; the browser asks the user for permission the first time.

## Example

The HR example application is a PWA: install it from the browser menu on a phone, open a few pages,
switch on airplane mode, and file a leave request; it is sent when the connection is back. Its
employee form records a work location and takes the photo with the camera (`examples/hr/hr_12_pwa.sql`).

## Not included

Push notifications (APEX 23.1) need a push service and stored subscriptions; they are not part of
pgapex yet. Native app store packaging is not needed: the installed PWA is the app.
