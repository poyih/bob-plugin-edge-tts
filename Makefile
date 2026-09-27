JSC     := /System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc
NAME    := bob-plugin-edge-tts
VERSION := $(shell python3 -c 'import json; print(json.load(open("src/info.json"))["version"])')
BUNDLE  := dist/$(NAME)-$(VERSION).bobplugin
PYFILES := $(sort $(wildcard scripts/*.py))

.DEFAULT_GOAL := help

help: ## 显示可用命令
	@grep -E '^[a-z-]+:.*?## ' $(MAKEFILE_LIST) | awk -F':.*?## ' '{printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'

lint: ## 检查 JS/Python 语法和 JSON 格式
	@$(JSC) -e 'var fs=["src/main.js","src/config.js","scripts/test_plugin.js"]; for (var i=0;i<fs.length;i++){ checkSyntax(fs[i]); print("syntax ok  "+fs[i]); }'
	@PYTHONDONTWRITEBYTECODE=1 python3 -c 'from pathlib import Path; fs=[Path(f) for f in "$(PYFILES)".split()]; [compile(p.read_text(encoding="utf-8"), str(p), "exec") for p in fs]; [print("syntax ok  "+str(p)) for p in fs]'
	@python3 -c 'import json; [print("json ok    "+f) for f in ["src/info.json","appcast.json"] if json.load(open(f)) is not None]'
	@PYTHONDONTWRITEBYTECODE=1 python3 scripts/check_info.py

test: lint ## 跑全部离线单测（用 Bob 同款 JavaScriptCore，不联网）
	@out=$$($(JSC) scripts/test_plugin.js) ; \
	 echo "$$out" ; \
	 echo "$$out" | grep -q '^ALL PASS' || { echo "测试未通过"; exit 1; }

pack: test ## 打包成 dist/*.bobplugin
	@rm -rf dist && mkdir -p dist
	@cd src && zip -qrX "../$(BUNDLE)" . -x '*.DS_Store'
	@echo "$(BUNDLE)"
	@shasum -a 256 "$(BUNDLE)"

install: pack ## 打包并交给 Bob 安装
	@open "$(BUNDLE)"

appcast: ## 把 dist/ 里的包写进 appcast.json（DESC="更新说明"）
	@python3 scripts/update_appcast.py --bundle "$(BUNDLE)" --desc "$(DESC)"

voices: ## 联网核对 config.js 与 info.json 里的音色是否还在微软的音色列表里
	@PYTHONDONTWRITEBYTECODE=1 python3 scripts/check_voices.py $(VOICES_ARGS)

clean: ## 清理构建产物
	@rm -rf dist

.PHONY: help lint test pack install appcast voices clean
