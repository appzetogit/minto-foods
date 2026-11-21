import { useEffect } from "react";

// Same markup as the splash in index.html (styles live there), so the hand-off
// from the static HTML to React shows no change while the app config loads.
// Used on the public homepage only, so it also holds the MintoFood tab title
// against the saved company name until the homepage takes over.
export default function BrandSplash() {
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.ownTitle = "1";
    document.title = "MintoFood";
    return () => {
      delete root.dataset.ownTitle;
    };
  }, []);

  return (
    <div className="mf-splash" role="status" aria-label="Loading MintoFood">
      <img className="mf-splash__logo" src="/minto-logo.png" alt="" />
      <div className="mf-splash__word"><b>Minto</b><i>Food</i></div>
      <div className="mf-splash__lines" aria-hidden="true"><span /><span /><span /></div>
    </div>
  );
}
