import { useState, useEffect } from "react";
import { signerManager, FormstrAuthButton, FormstrAuthModal, IUser } from "../../src";

function App() {
  const [modalOpen, setModalOpen] = useState(false);
  const [user, setUser] = useState<IUser | null>(null);

  useEffect(() => {
    signerManager.init();
    setUser(signerManager.getUser());

    const unsub = signerManager.onUserChange(() => {
      setUser(signerManager.getUser());
    });
    return unsub;
  }, []);

  return (
    <div style={{ padding: '20px', fontFamily: 'sans-serif', maxWidth: '800px', margin: '0 auto', color: '#1a1a1a' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #f0f0f0', paddingBottom: '20px', marginBottom: '40px' }}>
        <h3 style={{ margin: 0, fontWeight: 500, letterSpacing: '-0.5px' }}>Pre-Built-Button</h3>
        <div style={{ display: 'flex', gap: '32px', alignItems: 'center' }}>
          
          <div style={{ textAlign: 'right' }}>
            <span style={{ fontSize: '9px', display: 'block', marginBottom: '4px', color: '#999', textTransform: 'uppercase' }}>Pre-Built-Button</span>
            <FormstrAuthButton />
          </div>

          <div style={{ width: '1px', height: '30px', background: '#eee' }}></div>

          <div style={{ textAlign: 'right' }}>
            <span style={{ fontSize: '9px', display: 'block', marginBottom: '4px', color: '#999', textTransform: 'uppercase' }}>Custom UI</span>
            {user ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }} onClick={() => signerManager.logout()}>
                 <span style={{ fontSize: '14px' }}>{user.name}</span>
                 <img src={user.picture} style={{ width: 26, height: 26, borderRadius: '50%', border: '1px solid #eee' }} alt="P" />
              </div>
            ) : (
              <button 
                onClick={() => setModalOpen(true)}
                style={{ padding: '6px 12px', borderRadius: '4px', border: '1px solid #ccc', background: 'white', cursor: 'pointer', fontSize: '13px' }}
              >
                Log In
              </button>
            )}
          </div>

        </div>
      </header>

      <main style={{ textAlign: 'left', padding: '40px 0' }}>
        {user ? (
          <div>
            <h4 style={{ margin: '0 0 8px 0', fontWeight: 500 }}>Active Session</h4>
            <p style={{ margin: 0, fontSize: '13px', color: '#666', fontFamily: 'monospace', background: '#f9f9f9', padding: '12px', borderRadius: '4px' }}>
              {user.pubkey}
            </p>
            {user.nip05 && <p style={{ fontSize: '12px', marginTop: '12px' }}>Account: {user.nip05}</p>}
          </div>
        ) : (
          <p style={{ color: '#999', fontSize: '14px' }}>Please log in to verify the authentication flow.</p>
        )}
      </main>

      {/* Manual Modal for the Custom Button */}
      <FormstrAuthModal 
        open={modalOpen} 
        onClose={() => setModalOpen(false)} 
        onSuccess={() => setModalOpen(false)}
        logoUrl="logo.png"
      />
    </div>
  );
}

export default App;
