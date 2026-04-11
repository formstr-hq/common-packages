import React, { useState, useEffect, useRef } from "react";
import "./FormstrAuth.css";
import { LogoutIcon } from "./Icons";
import { signerManager } from "../core/SignerManager";
import { FormstrAuthModal } from "./FormstrAuthModal";
import { IUser } from "../core/types";

export interface FormstrAuthButtonProps {
  label?: string;
  title?: string;
  description?: string;
  logoUrl?: string;
  customRelays?: string[];
}

export const FormstrAuthButton: React.FC<FormstrAuthButtonProps> = ({
  label = "Sign In",
  title,
  description,
  logoUrl,
  customRelays
}) => {
  const [modalOpen, setModalOpen] = useState(false);
  const [user, setUser] = useState<IUser | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    signerManager.init();
    setUser(signerManager.getUser());
    const cleanup = signerManager.onUserChange(() => setUser(signerManager.getUser()));
    
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    
    return () => {
      cleanup();
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, []);

  const handleLogout = async () => {
    await signerManager.logout();
    setMenuOpen(false);
  };

  return (
    <div className="fs-menu-wrapper" ref={menuRef}>
      {user ? (
        <>
          <button 
            className="fs-auth-btn" 
            onClick={() => setMenuOpen(!menuOpen)}
          >
            <span style={{ marginRight: "4px" }}>{user.name}</span>
            {user.picture && (
              <img src={user.picture} alt={user.name} className="fs-avatar" />
            )}
          </button>
          
          {menuOpen && (
            <div className="fs-menu">
              <button 
                className="fs-menu-item fs-menu-item-error" 
                onClick={handleLogout}
              >
                <LogoutIcon style={{ width: 16 }} />
                <span>Logout</span>
              </button>
            </div>
          )}
        </>
      ) : (
        <button 
          className="fs-button-primary" 
          style={{ background: "transparent", color: "black", border: "1px solid black", borderRadius: "4px" }}
          onClick={() => setModalOpen(true)}
        >
          {label}
        </button>
      )}

      <FormstrAuthModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onSuccess={() => setModalOpen(false)}
        title={title}
        description={description}
        logoUrl={logoUrl}
        customRelays={customRelays}
      />
    </div>
  );
};
