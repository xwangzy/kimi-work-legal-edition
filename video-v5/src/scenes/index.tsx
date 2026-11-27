import type { ComponentType } from "react";
import type { SceneKey } from "../timeline";
import { S1Corpus } from "./S1Corpus";
import { Placeholder } from "./Placeholder";
import { S5OneTake } from "./S5OneTake";
import { S2Night } from "./S2Night";
import { S3Turn } from "./S3Turn";
import { S4Home } from "./S4Home";
import { S6Answers } from "./S6Answers";
import { S7Dawn } from "./S7Dawn";
import { S8Finale } from "./S8Finale";

const P = (name: string) => () => <Placeholder name={name} />;
export const SCENE_COMPONENTS: Record<SceneKey, ComponentType> = {
  corpus: S1Corpus,
  night: S2Night,
  turn: S3Turn,
  home: S4Home,
  onetake: S5OneTake,
  answers: S6Answers,
  dawn: S7Dawn,
  finale: S8Finale,
};
