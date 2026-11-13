The library holds agent templates, skills and workflow templates. It is never
loaded into an agent: each workspace picks its skills from it in skills.yaml.

Each skill keeps every version in a numbered folder, `skills/<name>/<n>/SKILL.md`.
`skills/<name>/skill.yaml` records which versions an agent proposed; a version not
listed there was written by a person, and agents can't change it.
