#!/bin/bash
cd /home/kavia/workspace/code-generation/document-hub-platform-335030/nextjs_backend
npm run lint
LINT_EXIT_CODE=$?
if [ $LINT_EXIT_CODE -ne 0 ]; then
  exit 1
fi

