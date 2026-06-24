import React, { useState } from "react";
import { Input } from "../ui";

export interface NewItemInputProps {
  placeholder: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
  /** Pre-fill the field (e.g. to rename an existing item). Default "". */
  initialValue?: string;
}

/** Inline row for naming a new workspace/project; Enter submits, Escape cancels. */
export const NewItemInput: React.FC<NewItemInputProps> = ({
  placeholder,
  onSubmit,
  onCancel,
  initialValue
}) => {
  const [value, setValue] = useState(initialValue ?? "");

  const submit = () => {
    const name = value.trim();
    if (name) {
      onSubmit(name);
    } else {
      onCancel();
    }
  };

  return (
    <div className="px-1 py-1">
      <Input
        autoFocus
        value={value}
        placeholder={placeholder}
        onChange={(event) => setValue(event.target.value)}
        onBlur={submit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            submit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        }}
      />
    </div>
  );
};
