# Convenience targets. Everything here is a thin wrapper around the underlying
# tool, so nothing depends on make being installed.

ENGINE := engine
ENGINE_TESTS := $(ENGINE)/.venv-tests

.PHONY: help setup engine serve frontend desktop build test lint clean package

help:
	@echo "openDAQ Studio"
	@echo
	@echo "  make setup      Install the UI's, the desktop shell's and the engine's dependencies"
	@echo "  make engine     Build the openDAQ engine for this computer"
	@echo "  make serve      Serve the engine's API on port 8420, with a reference device"
	@echo "  make frontend   Run the UI dev server against it (needs 'make serve' too)"
	@echo "  make desktop    Run the desktop app from source"
	@echo "  make build      Build the UI"
	@echo "  make test       Run the UI's tests and the engine's API tests"
	@echo "  make lint       Type check and lint the UI and the desktop shell"
	@echo "  make package    Build the desktop installer for this platform"
	@echo "  make clean      Remove build output"

setup:
	npm --prefix frontend install
	npm --prefix desktop install
	npm --prefix $(ENGINE)/node install
	python3 -m venv $(ENGINE_TESTS)
	$(ENGINE_TESTS)/bin/pip install -r $(ENGINE)/tests/api/requirements.txt
	@echo "\nReady.  Run 'make engine', then 'make desktop'."

engine:
	$(ENGINE)/tool/build_desktop.sh

serve:
	node $(ENGINE)/tool/serve.mjs --port 8420 --device daqref://device0

frontend:
	npm --prefix frontend run dev

desktop: build
	npm --prefix desktop run dev

build:
	npm --prefix frontend run build

test:
	npm --prefix frontend run test
	$(ENGINE_TESTS)/bin/pytest $(ENGINE)/tests/api -q

lint:
	npm --prefix frontend run typecheck
	npm --prefix frontend run lint
	npm --prefix desktop exec -- tsc -p tsconfig.json --noEmit

package:
	python3 scripts/build_desktop.py

clean:
	rm -rf frontend/dist desktop/dist desktop/release
