import React, { useEffect, useState, type ReactNode } from "react";
import { QRCodeCanvas } from "qrcode.react";
import { 
  VpnKeyIcon, 
  HubIcon, 
  PersonIcon, 
  PhonelinkLockIcon, 
  ChevronRightIcon, 
  ContentCopyIcon,
  LockOutlined,
  InfoIcon
} from "./Icons";

import { signerManager } from "../core/SignerManager";
import { getAppSecretKeyFromLocalStorage } from "../core/utils";
import { getPublicKey, generateSecretKey } from "nostr-tools";
import { bytesToHex } from "nostr-tools/utils";
import { 
  getNcryptsecFromLocalStorage, 
  removeNcryptsecFromLocalStorage 
} from "../core/utils";
import { createNostrConnectURI, Nip46Relays } from "../core/nip46";
import { isAndroidNative, isNative, isMobileBrowser } from "../utils/platform";
import { NostrSigner, IUser } from "../core/types";

// --- Sub-components ---

const OptionButton: React.FC<{
  icon: ReactNode;
  title: string;
  description: string;
  onClick: () => void;
  showChevron?: boolean;
  chevronRotated?: boolean;
}> = ({ icon, title, description, onClick, showChevron, chevronRotated }) => {
  return (
    <button className="fs-option-button" onClick={onClick}>
      <div className="fs-option-icon-box">
        {icon}
      </div>
      <div className="fs-option-text">
        <span className="fs-option-title">{title}</span>
        <span className="fs-option-desc">{description}</span>
      </div>
      {showChevron && (
        <ChevronRightIcon 
          className="fs-chevron" 
          style={{ 
            opacity: 0.5, 
            transform: chevronRotated ? "rotate(90deg)" : "none",
            transition: "transform 0.2s" 
          }} 
        />
      )}
    </button>
  );
};

const Nip46Section: React.FC<{ onSuccess: () => void; onError: (msg: string) => void; relays: string[] }> = ({
  onSuccess,
  onError,
  relays
}) => {
  const [activeTab, setActiveTab] = useState("manual");
  const [bunkerUri, setBunkerUri] = useState("");
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const [qrPayload] = useState(() => {
    const clientSecretKey = getAppSecretKeyFromLocalStorage();
    const clientPubkey = getPublicKey(clientSecretKey);
    const secret = Math.random().toString(36).slice(2, 10);
    return createNostrConnectURI({
      clientPubkey,
      relays: relays,
      secret,
      perms: ["nip44_encrypt", "nip44_decrypt", "sign_event", "get_public_key"],
      name: "Formstr Auth",
    });
  });

  const connect = async (uri: string) => {
    const cleanUri = uri.trim();
    if (!cleanUri) return;
    onError("");
    setLoading(true);
    try {
      await signerManager.loginWithNip46(cleanUri);
      onSuccess();
    } catch (e: any) {
      onError(e.message || "Connection failed");
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(qrPayload);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="fs-section-container">
      <div className="fs-tabs">
        <button 
          className={`fs-tab ${activeTab === "manual" ? "active" : ""}`}
          onClick={() => { setActiveTab("manual"); onError(""); }}
        >
          Paste URI
        </button>
        <button 
          className={`fs-tab ${activeTab === "qr" ? "active" : ""}`}
          onClick={() => { setActiveTab("qr"); onError(""); connect(qrPayload); }}
        >
          QR Code
        </button>
      </div>

      {activeTab === "manual" && (
        <div className="fs-input-row">
          <input
            className="fs-input"
            placeholder="bunker://... or name@domain.com"
            value={bunkerUri}
            onChange={(e) => setBunkerUri(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && connect(bunkerUri)}
          />
          <button
            className="fs-button-primary"
            onClick={() => connect(bunkerUri)}
            disabled={loading || !bunkerUri.trim()}
          >
            {loading ? <div className="fs-spinner" /> : "Connect"}
          </button>
        </div>
      )}

      {activeTab === "qr" && (
        <div style={{ textAlign: "center", padding: "8px 0" }}>
          <QRCodeCanvas value={qrPayload} size={160} />
          <div style={{ display: "flex", justifyContent: "center", alignItems: "center", marginTop: "8px", gap: "4px" }}>
            <button 
              onClick={handleCopy} 
              style={{ background: "transparent", border: "none", cursor: "pointer", display: "flex" }}
            >
              <ContentCopyIcon style={{ color: copied ? "var(--fs-success)" : "inherit", width: 18 }} />
            </button>
            <span style={{ fontSize: "12px", color: copied ? "var(--fs-success)" : "var(--fs-text-secondary)" }}>
              {copied ? "Copied!" : "Copy Connection URI"}
            </span>
          </div>
        </div>
      )}
    </div>
  );
};

const NsecSection: React.FC<{ onSuccess: () => void; onError: (msg: string) => void }> = ({
  onSuccess,
  onError
}) => {
  const [nsec, setNsec] = useState("");
  const [loading, setLoading] = useState(false);

  const handleLogin = async () => {
    const cleanNsec = nsec.trim();
    if (!cleanNsec) return;
    onError("");
    setLoading(true);
    try {
      await signerManager.loginWithPrivkey(cleanNsec);
      onSuccess();
    } catch (e: any) {
      onError(e.message || "Invalid private key");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fs-section-container">
      <div className="fs-input-row">
        <input
          className="fs-input"
          type="password"
          placeholder="nsec1..."
          value={nsec}
          onChange={(e) => setNsec(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleLogin()}
        />
        <button
          className="fs-button-primary"
          onClick={handleLogin}
          disabled={loading || !nsec.trim()}
        >
          {loading ? <div className="fs-spinner" /> : "Login"}
        </button>
      </div>
    </div>
  );
};

const NcryptsecSection: React.FC<{ onSuccess: () => void; onError: (msg: string) => void }> = ({
  onSuccess,
  onError
}) => {
  const [ncryptsec, setNcryptsec] = useState(() => getNcryptsecFromLocalStorage() ?? "");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const stored = !!getNcryptsecFromLocalStorage();

  const handleLogin = async () => {
    if (!ncryptsec.trim() || !password) return;
    onError("");
    setLoading(true);
    try {
      await signerManager.loginWithNcryptsec(ncryptsec.trim(), password);
      onSuccess();
    } catch (e: any) {
      onError("Invalid key or wrong password");
    } finally {
      setLoading(false);
    }
  };

  const handleForget = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirm("Forget this encrypted key on this device?")) {
      removeNcryptsecFromLocalStorage();
      setNcryptsec("");
    }
  };

  return (
    <div className="fs-section-container">
      <input
        className="fs-input"
        placeholder="ncryptsec1..."
        value={ncryptsec}
        onChange={(e) => setNcryptsec(e.target.value)}
        style={{ marginBottom: 10, display: "block" }}
      />
      {stored && ncryptsec && (
        <div style={{ textAlign: "right", marginTop: -4, marginBottom: 8 }}>
          <button className="fs-link-button" onClick={handleForget}>Forget saved key</button>
        </div>
      )}
      <div className="fs-input-row">
        <input
          className="fs-input"
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleLogin()}
        />
        <button
          className="fs-button-primary"
          onClick={handleLogin}
          disabled={loading || !ncryptsec.trim() || !password}
        >
          {loading ? <div className="fs-spinner" /> : "Sign In"}
        </button>
      </div>
    </div>
  );
};

const SignUpSection: React.FC<{ onSuccess: () => void; onError: (msg: string) => void }> = ({
  onSuccess,
  onError
}) => {
  const [step, setStep] = useState<"info" | "backup">("info");
  const [metadata, setMetadata] = useState<Partial<IUser>>({});
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [ncryptsecResult, setNcryptsecResult] = useState("");
  const [loading, setLoading] = useState(false);

  const handleCreate = async () => {
    if (!password) return onError("Password is required");
    if (password !== confirmPassword) return onError("Passwords do not match");
    
    setLoading(true);
    try {
      const result = await signerManager.signUpWithPassword(password, metadata);
      setNcryptsecResult(result);
      setStep("backup");
    } catch (e: any) {
      onError(e.message || "Failed to create account");
    } finally {
      setLoading(false);
    }
  };

  if (step === "backup") {
    return (
      <div className="fs-section-container">
        <div className="fs-alert" style={{ background: "var(--fs-warning-bg)", color: "var(--fs-warning-text)", border: "1px solid var(--fs-warning-border)" }}>
          Save this encrypted key. It's the only way to recover your account.
        </div>
        <div style={{ marginTop: 12 }}>
          <span className="fs-option-desc">Your encrypted secret key (ncryptsec):</span>
          <div className="fs-code-box">
             {ncryptsecResult}
             <button className="fs-copy-button" onClick={() => navigator.clipboard.writeText(ncryptsecResult)}>
                <ContentCopyIcon style={{ width: 14 }} />
             </button>
          </div>
        </div>
        <button className="fs-button-primary" style={{ width: "100%", marginTop: 16 }} onClick={onSuccess}>
          I've saved my key
        </button>
      </div>
    );
  }

  return (
    <div className="fs-section-container">
      <div className="fs-signup-form">
        <input className="fs-input" placeholder="Name (optional)" value={metadata.display_name || ""} onChange={e => setMetadata({...metadata, display_name: e.target.value})} />
        <input className="fs-input" placeholder="Username (optional)" value={metadata.name || ""} onChange={e => setMetadata({...metadata, name: e.target.value})} />
        <textarea className="fs-input" placeholder="About (optional)" value={metadata.about || ""} onChange={e => setMetadata({...metadata, about: e.target.value})} rows={2} style={{ resize: "none" }} />
        <input className="fs-input" placeholder="Picture URL (optional)" value={metadata.picture || ""} onChange={e => setMetadata({...metadata, picture: e.target.value})} />
        
        <div style={{ margin: "4px 0", height: 1, background: "rgba(0,0,0,0.05)" }} />
        
        <p className="fs-option-desc" style={{ marginBottom: 4, marginTop: 4, lineHeight: 1.5, textAlign: "center" }}>
          Your Nostr key will be encrypted with this password. Choose it carefully — there's no way to recover your account without it.
        </p>
        <input className="fs-input" type="password" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)} />
        <input className="fs-input" type="password" placeholder="Confirm Password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} />
        
        <button className="fs-button-primary" style={{ width: "100%", marginTop: 4 }} onClick={handleCreate} disabled={loading}>
          {loading ? <div className="fs-spinner" /> : "Create Account"}
        </button>
      </div>
    </div>
  );
};

// --- Main Modal ---

import FORMSTR_LOGO from "../assets/logo.png";

export interface FormstrAuthModalProps {
  open: boolean;
  onClose: () => void;
  onSuccess: (signer: NostrSigner) => void;
  title?: string;
  description?: string;
  logoUrl?: string;
  customRelays?: string[];
}

export const FormstrAuthModal: React.FC<FormstrAuthModalProps> = ({
  open,
  onClose,
  onSuccess,
  title = "Welcome to Formstr",
  description = "Sign in or create a new account",
  logoUrl = FORMSTR_LOGO,
  customRelays = Nip46Relays,
}) => {
  const [activeMode, setActiveMode] = useState<"signin" | "signup">("signin");
  const [showNip46, setShowNip46] = useState(false);
  const [showNcryptsec, setShowNcryptsec] = useState(() => !!getNcryptsecFromLocalStorage());
  const [showNsec, setShowNsec] = useState(false);
  const [error, setError] = useState("");
  const [installedSigners, setInstalledSigners] = useState<{ packageName: string; name: string; iconUrl?: string }[]>([]);

  useEffect(() => {
    if (!open) {
      setShowNip46(false);
      setShowNcryptsec(!!getNcryptsecFromLocalStorage());
      setShowNsec(false);
      setError("");
      setActiveMode("signin");
    }
  }, [open]);

  useEffect(() => {
    if (isAndroidNative()) {
      import("nostr-signer-capacitor-plugin").then(({ NostrSignerPlugin }) => {
        NostrSignerPlugin.getInstalledSignerApps().then((res) => {
          setInstalledSigners(res.apps);
        });
      });
    }
  }, []);

  const handleSuccess = () => {
    const signer = signerManager.getSigner();
    if (signer) onSuccess(signer);
    onClose();
  };

  const handleNip07 = async () => {
    setError("");
    try {
      await signerManager.loginWithNip07();
      handleSuccess();
    } catch (e: any) {
      setError(e.message || "Extension login failed");
    }
  };

  const handleGuest = async () => {
    setError("");
    try {
      const key = bytesToHex(generateSecretKey());
      await signerManager.loginAsGuest(key);
      handleSuccess();
    } catch (e: any) {
      setError(e.message || "Guest login failed");
    }
  };

  const handleNip55 = async (packageName: string) => {
    setError("");
    try {
      await signerManager.loginWithNip55(packageName);
      handleSuccess();
    } catch (e: any) {
      setError(e.message || "External signer failed");
    }
  };

  if (!open) return null;

  return (
    <div className="fs-modal-overlay" onClick={onClose}>
      <div className="fs-modal-content" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="fs-modal-header">
          {logoUrl && <img src={logoUrl} alt="Logo" className="fs-logo" />}
          <div>
            <h2 className="fs-title">{title}</h2>
            <p className="fs-description">{description}</p>
          </div>
          {error && <div className="fs-alert">{error}</div>}
        </div>

        {/* Tabs */}
        <div className="fs-tabs" style={{ background: "transparent", borderBottom: "1px solid rgba(0,0,0,0.05)", borderRadius: 0, padding: 0 }}>
          <button 
            className={`fs-tab ${activeMode === "signin" ? "active" : ""}`}
            onClick={() => setActiveMode("signin")}
            style={{ borderRadius: 0 }}
          >
            Sign In
          </button>
          <button 
            className={`fs-tab ${activeMode === "signup" ? "active" : ""}`}
            onClick={() => setActiveMode("signup")}
            style={{ borderRadius: 0 }}
          >
            Create Account
          </button>
        </div>

        {/* Options */}
        <div className="fs-options-list" style={{ marginTop: 16 }}>
          {activeMode === "signin" ? (
            <>
              {!isNative && (
                <OptionButton
                  icon={<VpnKeyIcon />}
                  title="Browser Extension"
                  description="Sign with Alby, nos2x, or Flamingo"
                  onClick={handleNip07}
                />
              )}

              {isAndroidNative() && (
                <>
                  {installedSigners.map((app) => (
                    <OptionButton
                      key={app.packageName}
                      icon={app.iconUrl ? <img src={app.iconUrl} alt={app.name} style={{ width: 24, height: 24, borderRadius: 4 }} /> : <PhonelinkLockIcon />}
                      title={app.name}
                      description="Sign with external Android app"
                      onClick={() => handleNip55(app.packageName)}
                    />
                  ))}
                  {installedSigners.length === 0 && (
                    <OptionButton
                      icon={<PhonelinkLockIcon />}
                      title="External Signer"
                      description="Sign using a NIP-55 compatible app"
                      onClick={() => handleNip55("com.greenart7c3.nostrsigner")}
                    />
                  )}
                </>
              )}

              <div>
                <OptionButton
                  icon={<LockOutlined style={{ color: "var(--fs-accent)", width: 22 }} />}
                  title="Encrypted Key (NIP-49)"
                  description="Sign in with your password-protected key"
                  onClick={() => {
                    setShowNcryptsec(!showNcryptsec);
                    setShowNip46(false);
                    setShowNsec(false);
                  }}
                  showChevron
                  chevronRotated={showNcryptsec}
                />
                {showNcryptsec && <NcryptsecSection onSuccess={handleSuccess} onError={setError} />}
              </div>

              <div>
                <OptionButton
                  icon={<HubIcon />}
                  title="Remote Signer"
                  description="Connect via NIP-46 (Bunker)"
                  onClick={() => {
                    setShowNip46(!showNip46);
                    setShowNcryptsec(false);
                    setShowNsec(false);
                  }}
                  showChevron
                  chevronRotated={showNip46}
                />
                {showNip46 && <Nip46Section onSuccess={handleSuccess} onError={setError} relays={customRelays} />}
              </div>

              {(isNative || isMobileBrowser()) && (
                <div>
                  <OptionButton
                    icon={<VpnKeyIcon />}
                    title="Private Key (nsec)"
                    description="Paste your raw private key"
                    onClick={() => {
                      setShowNsec(!showNsec);
                      setShowNcryptsec(false);
                      setShowNip46(false);
                    }}
                    showChevron
                    chevronRotated={showNsec}
                  />
                  {showNsec && <NsecSection onSuccess={handleSuccess} onError={setError} />}
                </div>
              )}

              <OptionButton
                icon={<PersonIcon />}
                title="Temporary Account"
                description="Instant access, persists on this device"
                onClick={handleGuest}
              />
            </>
          ) : (
            <SignUpSection onSuccess={handleSuccess} onError={setError} />
          )}
        </div>

        {/* Footer */}
        <div className="fs-footer">
          Your private keys never leave your device.
        </div>
      </div>
    </div>
  );
};
