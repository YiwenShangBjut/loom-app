import { useNavigate } from 'react-router-dom';
import './CreatePage.css';
import './CommunityPage.css';

const iconSize = 14;

const COMMUNITY_IMAGES = [
  'Rectangle 6.png',
  'Rectangle 7.png',
  'Rectangle 8.png',
  'Rectangle 9.png',
  'Rectangle 10.png',
  'Rectangle 11.png',
  'Rectangle 12.png',
  'Rectangle 89.png',
];

function IconBack() {
  return (
    <svg width={iconSize} height={iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M19 12H5" />
      <polyline points="12 19 5 12 12 5" />
    </svg>
  );
}

export function CommunityPage() {
  const navigate = useNavigate();

  return (
    <div className="create-page community-page">
      <header className="create-topbar">
        <div className="topbar-row">
          <button type="button" className="icon-btn" aria-label="返回" onClick={() => navigate(-1)}>
            <IconBack />
          </button>
          <h1 className="topbar-title">community</h1>
        </div>
        <p className="community-subtitle">Take a look at others&apos; menstrual artworks!</p>
      </header>

      <main className="community-content">
        <section className="community-grid" aria-label="Community artworks">
          {COMMUNITY_IMAGES.map((fileName) => (
            <div key={fileName} className="community-card">
              <img
                src={`./community/${encodeURIComponent(fileName)}`}
                alt={fileName.replace('.png', '')}
                className="community-image"
                loading="lazy"
              />
            </div>
          ))}
        </section>
      </main>
    </div>
  );
}
