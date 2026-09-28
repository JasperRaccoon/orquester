/**
 * An existing project, picked from the server's project index (workspace /
 * project), as a themed native select — a phone opens its own picker.
 */

import React, { useEffect, useMemo } from "react";

import { useApi } from "../../../context/orquester-context";
import { ensureProjectIndex, useProjectIndex } from "../../../lib/project-index";
import { useAppStore } from "../../../store/app";
import { SelectInput } from "./controls";

export const ProjectSelect: React.FC<{
  value: string;
  onChange: (path: string) => void;
  /** An empty choice first ("Same as the workflow"). */
  emptyLabel?: string;
  ariaLabel: string;
  id?: string;
}> = ({ value, onChange, emptyLabel, ariaLabel, id }) => {
  const api = useApi();
  const workspaces = useAppStore((state) => state.workspaces);
  const index = useProjectIndex();

  useEffect(() => {
    void ensureProjectIndex(api, workspaces).catch(() => undefined);
  }, [api, workspaces]);

  const projects = useMemo(
    () =>
      [...(index?.visible.values() ?? [])].sort(
        (a, b) => a.workspace.localeCompare(b.workspace) || a.name.localeCompare(b.name)
      ),
    [index]
  );
  const known = value === "" || projects.some((project) => project.path === value);

  return (
    <SelectInput id={id} value={value} aria-label={ariaLabel} onValue={onChange}>
      {emptyLabel !== undefined ? <option value="">{emptyLabel}</option> : null}
      {!known ? <option value={value}>{value}</option> : null}
      {projects.map((project) => (
        <option key={project.path} value={project.path}>
          {project.workspace} / {project.name}
        </option>
      ))}
    </SelectInput>
  );
};
