import { Link } from 'react-router-dom';
import { useStorage, fmtGb } from './StorageContext.jsx';

// Persistent local-storage banner. Shown on every page (it lives in the shell,
// above the routed pane) whenever the user is at/over the 3.5 GB notice — and,
// more urgently, at/over the 5 GB cap where new local writes are blocked. Driven
// by the shared storage status, so it appears on load, not only right after the
// write that crossed the line.
export default function StorageNotice() {
  const { status } = useStorage();
  if (!status || !status.atNotice) return null;

  const used = fmtGb(status.usedBytes);
  const cap = fmtGb(status.capBytes);

  return (
    <div className={`storage-notice${status.atCap ? ' at-cap' : ''}`} role="status">
      {status.atCap ? (
        <span>
          <strong>Local storage full — {used} of {cap}.</strong>{' '}
          New uploads and image/video generations are blocked. Existing chats and
          text still work. Delete some media in <Link to="/settings">Settings</Link> to free space.
        </span>
      ) : (
        <span>
          <strong>Local storage at {used} of {cap}.</strong>{' '}
          You're approaching the limit — new media writes are blocked once you
          reach {cap}. Manage storage in <Link to="/settings">Settings</Link>.
        </span>
      )}
    </div>
  );
}
