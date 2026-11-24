import { PROVIDER_LOGOS } from "./providerLogos.js";

export function ProviderLogo({ provider, className = "" }) {
  const logo = PROVIDER_LOGOS[provider];
  if (!logo) return null;
  return (
    <svg className={className} viewBox={logo.viewBox} preserveAspectRatio="xMidYMid" fill={logo.fill || "currentColor"} stroke="none" aria-hidden="true">
      {logo.paths.map((path) => {
        const d = path.d || path;
        return <path key={d.slice(0, 24)} d={d} fill={path.fill} fillRule={logo.evenOdd ? "evenodd" : undefined} clipRule={logo.evenOdd ? "evenodd" : undefined} />;
      })}
    </svg>
  );
}
