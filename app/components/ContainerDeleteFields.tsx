"use client";

// The guard for delete_container (contract §3.13): keeping the world is the
// default; deleting it has to be ticked, and then the container's name typed.
// Shared by Server Settings → Delete container and App Settings → Remove
// server.
import { Input, Label, TextField } from "@heroui/react";

/** Deleting the world too needs the container name typed out. */
export const canDeleteContainer = (deleteData: boolean, typed: string, containerName: string) =>
  !deleteData || typed.trim() === containerName;

interface ContainerDeleteFieldsProps {
  containerName: string;
  deleteData: boolean;
  onDeleteDataChange: (value: boolean) => void;
  typed: string;
  onTypedChange: (value: string) => void;
  isDisabled?: boolean;
}

export default function ContainerDeleteFields({
  containerName,
  deleteData,
  onDeleteDataChange,
  typed,
  onTypedChange,
  isDisabled = false,
}: ContainerDeleteFieldsProps) {
  return (
    <div className="flex flex-col gap-3">
      <label className="flex items-start gap-3 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          checked={deleteData}
          disabled={isDisabled}
          onChange={(event) => onDeleteDataChange(event.target.checked)}
        />
        <span>
          Also delete its world data
          <span className="mt-0.5 block text-xs text-muted">
            {deleteData
              ? "The world, its configs, its mods and every backup stored with it are deleted for good. This cannot be undone."
              : "Left unticked, the world is kept: creating the container again under the same name picks it back up."}
          </span>
        </span>
      </label>
      {deleteData && (
        <TextField
          className="flex flex-col gap-2"
          value={typed}
          onChange={onTypedChange}
          isDisabled={isDisabled}
        >
          <Label>
            Type <span className="font-mono text-danger">{containerName}</span> to confirm
          </Label>
          <Input className="font-mono" autoComplete="off" spellCheck={false} />
        </TextField>
      )}
    </div>
  );
}
