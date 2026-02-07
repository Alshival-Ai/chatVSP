import type { IconProps } from "@opal/types";

const SvgOnyxLogo = ({ size, ...props }: IconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 56 56"
    xmlns="http://www.w3.org/2000/svg"
    {...props}
  >
    <g fill="currentColor">
      <rect
        x="6"
        y="8"
        width="20"
        height="44"
        rx="10"
        transform="rotate(-35 16 30)"
      />
      <circle cx="40" cy="18" r="12" />
    </g>
  </svg>
);
export default SvgOnyxLogo;
