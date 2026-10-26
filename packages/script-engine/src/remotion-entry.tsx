import React from "react";
import {
  getInputProps,
  registerRoot,
} from "remotion";

import {
  YouCreatorRoot,
  type YouCreatorRootProps,
} from "./remotion-root.js";

const Root: React.FC = () => {
  const props =
    getInputProps() as unknown as YouCreatorRootProps;

  if (
    !props ||
    !props.manifest ||
    !props.imageUrls ||
    !props.audioUrl ||
    !props.captionPlan
  ) {
    throw new Error(
      "M7 Remotion root requires verified input props",
    );
  }

  return <YouCreatorRoot {...props} />;
};

registerRoot(Root);
