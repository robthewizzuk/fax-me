import React, { useState } from 'react';
import { BookUser, PhoneForwarded, Check, X, Radio, Bot } from 'lucide-react';

export default function DirectoryModal({
  open,
  session,
  geo,
  directory,
  onSaveProfile,
  onSelectNumber,
  onClose,
}) {
  const [nameInput, setNameInput] = useState(session?.displayName || '');
  const [listed, setListed] = useState(session?.listed ?? true);
  const [saving, setSaving] = useState(false);
  const [savedOk, setSavedOk] = useState(false);

  if (!open) return null;

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    setSavedOk(false);
    try {
      await onSaveProfile({ displayName: nameInput, listed });
      setSavedOk(true);
      setTimeout(() => setSavedOk(false), 2000);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="dir-title">
      <div className="retro-modal directory-modal">
        <div className="modal-header">
          <div>
            <span className="modal-kicker">LIVE DOT-MATRIX ADDRESS BOOK</span>
            <h2 id="dir-title">Global Fax Directory & Your Line</h2>
          </div>
          <button id="btn-close-dir" className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div className="modal-body">
          <form className="profile-card" onSubmit={handleSave}>
            <div className="profile-top">
              <div>
                <span className="mini-kicker">
                  {session?.flag} IP-GEOLOCATED LINE ({session?.countryName})
                </span>
                <div className="my-big-number">{session?.displayNumber}</div>
                <small className="geo-note">
                  Source: {geo?.source} {geo?.city ? `• ${geo.city}` : ''} • Persisted in cookie
                </small>
              </div>
              <label className="publish-toggle">
                <input
                  id="chk-list-directory"
                  type="checkbox"
                  checked={listed}
                  onChange={(e) => setListed(e.target.checked)}
                />
                <span>List in Public Address Book</span>
              </label>
            </div>

            <div className="profile-input-row">
              <input
                id="input-dir-name"
                type="text"
                maxLength={28}
                placeholder="Save a name/company next to your number (e.g. Area 51 HR)"
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
              />
              <button id="btn-save-dir-name" type="submit" className="btn-primary" disabled={saving}>
                {savedOk ? <><Check size={15} /> Saved</> : 'Save to Directory'}
              </button>
            </div>
          </form>

          <div className="dir-section-title">
            <BookUser size={15} /> Active Stations & Bots ({directory.length})
          </div>
          <p className="dir-hint">
            Tip: You can also browse this same directory directly on the 3D machine's green LCD using the <strong>DIR</strong>, <strong>▲</strong>, <strong>▼</strong>, and <strong>OK</strong> keys. Offline stations will ring and return <em>No Answer (480)</em>.
          </p>

          <div className="dir-list">
            {directory.map((entry) => (
              <div key={entry.id} className="dir-row">
                <div className="dir-left">
                  <span
                    className={`status-dot ${entry.online ? 'online' : 'offline'}`}
                    title={entry.online ? 'Online' : 'Offline (Ring No Answer)'}
                  />
                  <span className="dir-flag">{entry.flag}</span>
                  <div>
                    <div className="dir-name">
                      {entry.display_name}
                      {entry.isBot && (
                        <span className="badge-bot">
                          <Bot size={11} /> AUTO-REPLY BOT
                        </span>
                      )}
                      {entry.id === session?.id && <span className="badge-you">YOU</span>}
                    </div>
                    <div className="dir-num">{entry.display_number}</div>
                  </div>
                </div>
                <div className="dir-right">
                  <span className={`state-tag ${entry.online ? 'on' : 'off'}`}>
                    {entry.online ? <><Radio size={11} /> ONLINE</> : 'OFFLINE'}
                  </span>
                  <button
                    type="button"
                    className="btn-dial-row"
                    onClick={() => {
                      onSelectNumber(entry.display_number);
                      onClose();
                    }}
                  >
                    <PhoneForwarded size={13} /> Dial
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
