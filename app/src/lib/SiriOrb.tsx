/** Soft Siri-style orb that fills the mic button. */

type Props = {
  /** Listening / active voice capture */
  live?: boolean;
  /** Short press flash */
  burst?: boolean;
};

export default function SiriOrb({ live = false, burst = false }: Props) {
  return (
    <span
      className={`siri-orb${live ? " live" : ""}${burst ? " burst" : ""}`}
      aria-hidden="true"
    >
      <span className="siri-orb-spin" />
      <span className="siri-orb-blob b1" />
      <span className="siri-orb-blob b2" />
      <span className="siri-orb-blob b3" />
      <span className="siri-orb-blob b4" />
      <span className="siri-orb-core" />
      <span className="siri-orb-shine" />
    </span>
  );
}
