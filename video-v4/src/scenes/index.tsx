import type { ComponentType } from "react";
import type { SceneKey } from "../timeline";
import { S01Paper } from "./S01Paper";
import { S02Reveal } from "./S02Reveal";
import { S03Home } from "./S03Home";
import { S04Start } from "./S04Start";
import { S05Consent } from "./S05Consent";
import { S06Run, S07Proof, S07Risk, S08Cite, S09Decide } from "./S06Work";
import { S10Deliver, S11Signoff } from "./S10Deliver";
import { S12Breadth, S13Trust } from "./S12Breadth";
import { S14Value, S15Theme, S16Lockup, S17Partner } from "./S15Finale";

export const SCENE_COMPONENTS: Record<SceneKey, ComponentType> = {
  paper: S01Paper,
  reveal: S02Reveal,
  home: S03Home,
  start: S04Start,
  consent: S05Consent,
  run: S06Run,
  risk: S07Risk,
  proof: S07Proof,
  cite: S08Cite,
  decide: S09Decide,
  deliver: S10Deliver,
  signoff: S11Signoff,
  breadth: S12Breadth,
  trust: S13Trust,
  value: S14Value,
  theme: S15Theme,
  lockup: S16Lockup,
  partner: S17Partner,
};
