# 项目背景

## 这个项目是做什么的
鼎恒餐饮 SaaS 平台：面向餐饮商家的「门店经营 + 供应链采购 + 会员营销」一体化管理系统。
共四端：商家后台（admin）、供应商后台（supplier-dashboard）、开发者控制台（dev-console）、
顾客点餐/后厨看单/大屏展示（customer / kitchen / bigscreen）。

## 目标用户
- 餐饮商家：核心用户，点餐经营 + 采购食材 + 会员营销
- 食材供应商：供货方，接单、分拣过秤、发货配送、返点结算
- 平台开发者：运营方，审核、返点规则、结算、平台配置

## 商业模式
待补充，后续商业讨论后填入

## 技术栈
- 后端：Node.js + Express 4 + MongoDB（Mongoose 8）；JWT 三端鉴权 + bcrypt 密码；node-cron 定时任务
- Web 前端：原生 HTML/CSS/JavaScript（无构建），由 Express 静态托管 public/
- 小程序：uni-app（Vue 3）+ Vite，独立工程位于 uni-app/（功能为 Web 端子集）
- 数据库：MongoDB（生产使用 Atlas 云库）
- 完整架构说明见根目录 ARCHITECTURE.md

# AI 工作规范

- 每次对话开始时，自动读取项目里的 PROGRESS.md 文件，了解当前进度
- 商业讨论：先给核心观点，再展开，总字数不超过 400 字
- 代码任务：直接给可以用的代码片段，不要讲一大堆原理
- 当我说「更新进度」时，帮我把最新进展写入 PROGRESS.md
