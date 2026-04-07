import { useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { getSavedCreationsForAdmin } from '../savedCreation';
import { getCurrentSubjectId, isTryTutorialCompleted } from '../tryTutorialProgress';
import { getUserDisplayName } from '../userDisplayName';
import homeTitleDeco from '../assets/home-title-deco.png';
import homeCreateRight from '../assets/home-create-right.png';
import homeMyCreationRight from '../assets/home-my-creation-right.png';
import homeCommunityRight from '../assets/home-community-right.png';
import './HomePage.css';

export function HomePage() {
  const navigate = useNavigate();
  const titleTapCountRef = useRef(0);
  const titleLastTapAtRef = useRef(0);
  const savedDisplayName = getUserDisplayName();
  const homeTitleText = savedDisplayName
    ? `Hey, ${savedDisplayName}, time to craft your menstrual story!`
    : 'Hey, time to craft your menstrual story!';

  function handleCreateClick() {
    const subjectId = getCurrentSubjectId();
    const hasCompletedTry = isTryTutorialCompleted(subjectId);
    const hasSavedCreations = getSavedCreationsForAdmin().length > 0;

    // 已完成 try 导览最后一步，或已有 save 过的创作 → 直接进入 create 页面
    if (hasCompletedTry || hasSavedCreations) {
      navigate('/create');
      return;
    }

    // 未完成 try 导览：进入 try 的初始页（TryPage mount 后 tutorialPhase 默认是 'intro'）
    navigate('/try');
  }

  function handleTitleSecretTap() {
    const now = Date.now();
    const TAP_RESET_MS = 1500;
    if (now - titleLastTapAtRef.current > TAP_RESET_MS) {
      titleTapCountRef.current = 0;
    }
    titleLastTapAtRef.current = now;
    titleTapCountRef.current += 1;

    if (titleTapCountRef.current >= 5) {
      titleTapCountRef.current = 0;
      navigate('/admin');
    }
  }

  return (
    <div className="home-page">
      <div className="home-title-area">
        <h1 className="home-title" onClick={handleTitleSecretTap}>
          {homeTitleText}
        </h1>
        <img className="home-title-deco" src={homeTitleDeco} alt="" aria-hidden="true" />
      </div>
      <div className="home-title-spacer" />
      <div className="home-cards">
        <button
          type="button"
          className="home-card home-card-create"
          onClick={handleCreateClick}
        >
          <span className="home-card-create-text">Create</span>
          <img className="home-card-create-image" src={homeCreateRight} alt="" aria-hidden="true" />
        </button>
        <button
          type="button"
          className="home-card home-card-my-creation"
          onClick={() => navigate('/creation')}
        >
          <span className="home-card-my-creation-text">My creation</span>
          <img
            className="home-card-my-creation-image"
            src={homeMyCreationRight}
            alt=""
            aria-hidden="true"
          />
        </button>
        <Link to="/community" className="home-card home-card-community">
          <span className="home-card-community-text">Community</span>
          <img
            className="home-card-community-image"
            src={homeCommunityRight}
            alt=""
            aria-hidden="true"
          />
        </Link>
      </div>
    </div>
  );
}
