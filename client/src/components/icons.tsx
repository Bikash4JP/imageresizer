import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 18, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const LogoIcon = (p: IconProps) => (
  <Icon {...p} strokeWidth={2}>
    <path d="M4 9V5a1 1 0 0 1 1-1h4" />
    <path d="M20 15v4a1 1 0 0 1-1 1h-4" />
    <path d="M14 4h5a1 1 0 0 1 1 1v5" />
    <path d="m20 4-7 7" />
    <rect x="4" y="13" width="7" height="7" rx="1" />
  </Icon>
);

export const UploadIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 15V4" />
    <path d="m7 9 5-5 5 5" />
    <path d="M20 15v3a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-3" />
  </Icon>
);

export const RotateCcwIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
    <path d="M3 3v5h5" />
  </Icon>
);

export const RotateCwIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
    <path d="M21 3v5h-5" />
  </Icon>
);

export const FlipHIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3v18" strokeDasharray="2 2.5" />
    <path d="M8 7 3 17h5z" />
    <path d="m16 7 5 10h-5z" />
  </Icon>
);

export const FlipVIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 12h18" strokeDasharray="2 2.5" />
    <path d="M7 8 17 3v5z" />
    <path d="m7 16 10 5v-5z" />
  </Icon>
);

export const LinkIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
    <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
  </Icon>
);

export const UnlinkIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="m18.8 13.4 1.7-1.7a5 5 0 0 0-7-7l-1.7 1.7" />
    <path d="m5.2 10.6-1.7 1.7a5 5 0 0 0 7 7l1.7-1.7" />
    <path d="M8 2v3M2 8h3M16 22v-3M22 16h-3" />
  </Icon>
);

export const DownloadIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 4v11" />
    <path d="m7 10 5 5 5-5" />
    <path d="M5 20h14" />
  </Icon>
);

export const SunIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </Icon>
);

export const MoonIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />
  </Icon>
);

export const MonitorIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="4" width="18" height="12" rx="2" />
    <path d="M8 20h8M12 16v4" />
  </Icon>
);

export const CloseIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M18 6 6 18M6 6l12 12" />
  </Icon>
);

export const AlertIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 8v5M12 16.5v.01" />
  </Icon>
);

export const CheckIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="m5 12 5 5 9-10" />
  </Icon>
);

export const ResetIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 12a9 9 0 1 0 9-9 9.7 9.7 0 0 0-6.7 2.7L3 8" />
    <path d="M3 3v5h5" />
  </Icon>
);

export const ImageIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <circle cx="9" cy="9" r="2" />
    <path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
  </Icon>
);

export const PortraitIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="7" y="3" width="10" height="18" rx="1.5" />
  </Icon>
);

export const LandscapeIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="7" width="18" height="10" rx="1.5" />
  </Icon>
);
