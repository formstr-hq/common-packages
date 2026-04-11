# formstr-auth

A cross-platform Nostr authentication library providing a unified interface for **Anonymous Login**, **Browser Plugins (NIP-07)**, **Remote Signers (NIP-46)**, and **Native Android Signers (NIP-55)**.

Designed for developers who want a "zero-config" authentication experience that works seamlessly on Web and Mobile (via Capacitor).

## Features

- 🔌 **Unified Interface**: One button for Browser Plugins, Remote Signers, and Native Apps.
- 📱 **Android-support**: Best-in-class NIP-55 support for Android apps like Amber.
- ☁️ **Remote Signing**: Robust NIP-46 (Bunker/Nostr Connect) implementation with mobile backgrounding resilience.
- 👤 **Anonymous Login**: Support for ephemeral (guest) accounts for instant onboarding.
- 🔐 **Native Security**: Built-in `nsec` support optimized for native mobile environments.
- ⚡ **Self-Sufficient**: Bundles all necessary UI components (MUI) and assets.

## Installation

```bash
npm install formstr-auth
```

## Quick Start (Pre-built Button)

The easiest way to add identity to your app. It handles the modal, login states, and profile metadata automatically.

```tsx
import { FormstrAuthButton } from "formstr-auth";

function App() {
  return (
    <nav>
      <h1>My App</h1>
      <FormstrAuthButton />
    </nav>
  );
}
```

### Button Properties

Customize the UI and behavior by passing these optional props to `<FormstrAuthButton />`:

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `label` | `string` | `"Sign In"` | Text shown on the button when logged out. |
| `title` | `string` | `"Sign in to Formstr"` | Header title inside the modal. |
| `description` | `string` | `"Choose your login method"` | Sub-header description inside the modal. |
| `logoUrl` | `string` | `(Formstr Logo)` | URL for the logo shown in the modal. |
| `customRelays` | `string[]` | `(Default Relays)` | Custom relay list for NIP-46 handshake. |

## Advanced Usage (Custom UI)

If you want to build your own UI, you can interact with the `signerManager` directly.

```tsx
import { signerManager, FormstrAuthModal } from "formstr-auth";
import { useEffect, useState } from "react";

function Profile() {
  const [user, setUser] = useState(signerManager.getUser());

  useEffect(() => {
    // Listen for login/logout or metadata updates
    return signerManager.onUserChange(() => {
      setUser(signerManager.getUser());
    });
  }, []);

  if (!user) return <p>Please log in</p>;

  return (
    <div>
      <img src={user.picture} alt={user.name} />
      <h3>{user.name}</h3>
      <button onClick={() => signerManager.logout()}>Logout</button>
    </div>
  );
}
```

## Android / Capacitor Setup

To use NIP-55 (External Signers) on Android, ensure you have the following installed in your Capacitor project:

```bash
npm install nostr-signer-capacitor-plugin
npx cap sync android
```

The library will automatically detect the environment and show the appropriate "External Signer" options.

## License

MIT
