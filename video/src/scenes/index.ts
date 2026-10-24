import type { ComponentType } from "react";
import type { SceneKey } from "../timeline";
import { S01Weight } from "./S01Weight";
import { S02Scatter } from "./S02Scatter";
import { S03Converge } from "./S03Converge";
import { S04Reveal } from "./S04Reveal";
import { S05Home } from "./S05Home";
import { S06Privacy } from "./S06Privacy";
import { S07Run } from "./S07Run";
import { S08Cite } from "./S08Cite";
import { S09Review } from "./S09Review";
import { S10Unify } from "./S10Unify";
import { S11Trust } from "./S11Trust";
import { S12Theme } from "./S12Theme";
import { S13Lockup } from "./S13Lockup";
import { S14Partner } from "./S14Partner";

export const SCENE_COMPONENTS: Record<SceneKey, ComponentType> = {
  weight: S01Weight,
  scatter: S02Scatter,
  converge: S03Converge,
  reveal: S04Reveal,
  home: S05Home,
  privacy: S06Privacy,
  run: S07Run,
  cite: S08Cite,
  review: S09Review,
  unify: S10Unify,
  trust: S11Trust,
  theme: S12Theme,
  lockup: S13Lockup,
  partner: S14Partner,
};
