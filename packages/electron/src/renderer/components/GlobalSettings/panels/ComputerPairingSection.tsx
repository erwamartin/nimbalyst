import React, { useState } from 'react';

const buttonClass = 'rounded border border-nim bg-nim-secondary px-2.5 py-1 text-[12px] text-nim cursor-pointer hover:bg-nim-hover disabled:opacity-50 disabled:cursor-not-allowed';

/** Shares this computer's sync key with another of the user's computers, or adopts theirs. */
export function ComputerPairingSection({ className = '' }: { className?: string }) {
  const [code, setCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pasted, setPasted] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);

  const showCode = async () => {
    setMessage(null);
    try {
      setCode(await window.electronAPI.credentials.computerPairingCode());
      setCopied(false);
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    }
  };

  const copyCode = async () => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      setMessage({ tone: 'error', text: 'Could not copy. Select the code and copy it by hand.' });
    }
  };

  const useCode = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const { changed, backupPath } = await window.electronAPI.credentials.useComputerPairingCode(pasted);
      setPasted('');
      setConfirming(false);
      setMessage({ tone: 'success', text: changed ? `Paired. This computer now uses the other computer’s sync key and has reconnected. The previous key is saved at ${backupPath}.` : 'This computer already uses that sync key. Sync has reconnected.' });
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`computer-pairing-section provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0 ${className}`}>
      <h4 className="provider-panel-section-title text-[15px] font-semibold mb-1 text-[var(--nim-text)]">Pair another computer</h4>
      <p className="m-0 mb-3 text-[12px] text-nim-muted leading-relaxed">
        To see and control this computer&apos;s sessions from another computer, copy this computer&apos;s pairing code and paste it on the other one. Both must be signed in with the same account.
      </p>

      <div className="flex flex-col gap-2 mb-4">
        {code ? (
          <div className="flex items-center gap-2">
            <input readOnly value={code} aria-label="Pairing code" className="flex-1 min-w-0 rounded border border-nim bg-nim-secondary px-2 py-1 font-mono text-[11px] text-nim select-text" />
            <button type="button" className={buttonClass} onClick={() => void copyCode()}>{copied ? 'Copied' : 'Copy'}</button>
            <button type="button" className={buttonClass} onClick={() => { setCode(null); setCopied(false); }}>Hide</button>
          </div>
        ) : (
          <div>
            <button type="button" className={buttonClass} onClick={() => void showCode()}>Show this computer&apos;s pairing code</button>
          </div>
        )}
        <p className="m-0 text-[11px] text-nim-faint">Anyone with this code can read your synced sessions. Only paste it on your own computers.</p>
      </div>

      <label className="block text-[12px] font-medium text-nim mb-1" htmlFor="computer-pairing-code-input">Use a code from another computer</label>
      <div className="flex items-center gap-2">
        <input
          id="computer-pairing-code-input"
          value={pasted}
          onChange={(event) => { setPasted(event.target.value); setConfirming(false); }}
          placeholder="Paste the pairing code"
          className="flex-1 min-w-0 rounded border border-nim bg-nim-secondary px-2 py-1 font-mono text-[11px] text-nim"
        />
        {!confirming && (
          <button type="button" className={buttonClass} disabled={!pasted.trim() || busy} onClick={() => setConfirming(true)}>Use code</button>
        )}
      </div>
      {confirming && (
        <div className="mt-2 rounded-lg border border-amber-500/20 bg-amber-500/10 p-2 text-[11px] text-amber-500">
          <p className="m-0 mb-2">This computer will switch to the other computer&apos;s sync key. Sessions this computer synced before will sync again under the new key. Phones or sandboxes paired with this computer must be paired again. The current key is kept in a backup file.</p>
          <div className="flex gap-2">
            <button type="button" className={buttonClass} disabled={busy} onClick={() => void useCode()}>{busy ? 'Pairing…' : 'Switch key'}</button>
            <button type="button" className={buttonClass} disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
          </div>
        </div>
      )}
      {message && (
        <p role={message.tone === 'error' ? 'alert' : 'status'} className={`m-0 mt-2 text-[12px] ${message.tone === 'error' ? 'text-nim-error' : 'text-nim-success'}`}>
          {message.text}
        </p>
      )}
    </div>
  );
}
