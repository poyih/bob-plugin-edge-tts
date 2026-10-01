# Bob 跑插件用的是 JavaScriptCore，结论以 macOS 自带的 jsc 为准；没有 jsc 时退回到 Node 跑同一套用例
JSC_MAC := /System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc
NODE    ?= node
JSC     := $(if $(wildcard $(JSC_MAC)),$(JSC_MAC),$(NODE) scripts/jsc_shim.js)
NAME    := bob-plugin-edge-tts
VERSION := $(shell python3 -c 'import json; print(json.load(open("src/info.json"))["version"])')
BUNDLE  := dist/$(NAME)-$(VERSION).bobplugin
PYFILES := $(sort $(wildcard scripts/*.py scripts/live/*.py))
JSFILES := $(sort $(wildcard src/*.js scripts/*.js))
# value 保留命令行 DESC 里的 $、引号与反引号，不把说明解释成 Make 或 Shell 代码。
export APPCAST_DESC := $(value DESC)
unexport DESC

.DEFAULT_GOAL := help

help: ## 显示可用命令
	@grep -E '^[a-z-]+:.*?## ' $(MAKEFILE_LIST) | awk -F':.*?## ' '{printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'

lint: ## 检查 JS/Python 语法和 JSON 格式
	@$(JSC) -e 'var fs="$(JSFILES)".split(" "); for (var i=0;i<fs.length;i++){ checkSyntax(fs[i]); print("syntax ok  "+fs[i]); }'
	@PYTHONDONTWRITEBYTECODE=1 python3 -c 'from pathlib import Path; fs=[Path(f) for f in "$(PYFILES)".split()]; [compile(p.read_text(encoding="utf-8"), str(p), "exec") for p in fs]; [print("syntax ok  "+str(p)) for p in fs]'
	@python3 -c 'import json; [print("json ok    "+f) for f in ["src/info.json","appcast.json"] if json.load(open(f)) is not None]'
	@PYTHONDONTWRITEBYTECODE=1 python3 scripts/check_info.py

test: lint ## 跑全部离线单测（macOS 用 Bob 同款 JavaScriptCore，其他系统用 Node，不联网）
	@out=$$($(JSC) scripts/test_plugin.js) ; \
	 echo "$$out" ; \
	 echo "$$out" | grep -q '^ALL PASS' || { echo "测试未通过"; exit 1; }
	@PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts -p 'test_*.py'

test-memory: ## 用 Node GC 检查原始音频是否在整次任务结束前释放
	@$(NODE) --expose-gc scripts/test_memory.js

pack: test ## 打包成 dist/*.bobplugin
	@rm -rf dist && mkdir -p dist
	@cd src && zip -qrX "../$(BUNDLE)" . -x '*.DS_Store'
	@echo "$(BUNDLE)"
	@shasum -a 256 "$(BUNDLE)"

install: pack ## 打包并交给 Bob 安装
	@open "$(BUNDLE)"

appcast: ## 把 dist/ 里的包写进 appcast.json（DESC="更新说明"）
	@python3 scripts/update_appcast.py --bundle "$(BUNDLE)"

voices: ## 联网核对 config.js 与 info.json 里的音色是否还在微软的音色列表里
	@PYTHONDONTWRITEBYTECODE=1 python3 scripts/check_voices.py $(VOICES_ARGS)

upstream: ## 联网对照上游 edge-tts 的协议常量，看 config.js 有没有落后
	@PYTHONDONTWRITEBYTECODE=1 python3 scripts/check_upstream.py $(UPSTREAM_ARGS)

clean: ## 清理构建产物
	@rm -rf dist

.PHONY: help lint test test-memory pack install appcast voices upstream clean
