# GitHub 参考与尺寸标注设计

核查日期：2026-09-26。

本次优化参考以下作者维护的 GitHub 项目，借鉴公开功能说明与边界情况；没有将这些项目的源码、图片、品牌素材或界面直接复制到本工具箱，也没有新增这些项目的运行时依赖。

## 参考来源

| 项目 | 参考内容 | 许可核查 |
| --- | --- | --- |
| [adamdehaven / specify](https://github.com/adamdehaven/specify) | 四边尺寸、两个对象间距、图纸比例、单位标签、样式选项、独立标注图层、设置记忆 | 本次查看的仓库根目录没有 LICENSE 文件，主要提供 README、更新记录和图片。仅参考公开产品行为，不按开源代码使用。 |
| [creold / illustrator-scripts](https://github.com/creold/illustrator-scripts) | Illustrator 脚本的单位换算、选择类型检查、剪切蒙版边界与大画布兼容处理 | 仓库 [LICENSE](https://github.com/creold/illustrator-scripts/blob/master/LICENSE) 为 MIT；部分脚本文件头同时含作者使用说明。本次未复制代码。 |

## 尺寸标注借鉴点

Specify 的 [Options and Styles](https://github.com/adamdehaven/specify#options-and-styles)、[Options Panel](https://github.com/adamdehaven/specify#options-panel) 和 [Styles Panel](https://github.com/adamdehaven/specify#styles-panel) 提供以下交互参考：

- 对象尺寸与两对象之间的距离应为明确的不同模式。
- 上、右、下、左可以分别选择；线宽、端线长度和文字尺寸应能独立配置。
- 图纸比例只影响显示的数值，不应缩放原对象。例如按 1:10 绘制的 20 mm 对象，标签显示 200 mm。
- 单位显示、小数位与末尾零应有明确选项。
- 独立图层、可编辑分组、参数记忆与恢复默认可降低重复操作成本。

以上用于确定交互方向，不表示本工具箱完整实现了参考项目的全部功能。分数英寸、字体枚举等能力可在需要时进一步扩展。

## 几何与兼容性审查依据

参考 [ResizeToSize.jsx](https://github.com/creold/illustrator-scripts/blob/master/jsx/ResizeToSize.jsx) 和 [Rescale.jsx](https://github.com/creold/illustrator-scripts/blob/master/jsx/Rescale.jsx) 识别的重点：

- 几何边界不含描边，可见边界包含描边；标注面板需要明确当前测量口径。
- 剪切组的整组边界可能含蒙版外内容，需识别剪切路径；普通群组和复合路径也不能当作简单路径处理。
- 大画布文档可能带有 `scaleFactor`，显示尺寸和输入的物理尺寸需要对应换算。
- 文本编辑状态的 `TextRange` 与对象选择不同；没有文档、空选择、无有效边界应返回可理解的提示。

## 本工具箱额外采用的可靠性要求

以下为针对本地代码审查制定的要求，并非上述项目的功能宣称：

- 绘制前复制选择对象列表，避免生成标注时选择集合改变。
- 先校验参数与可测量对象，再创建结果；无效输入不能留下空图层或半成品。
- 用工具专属标记识别生成内容，清理时不应仅根据通用图层名删除用户图稿。
- 标签倍率与大画布比例分开处理，避免重复换算。
- 两对象间距必须明确使用边缘间距还是中心距；重叠投影不能标成不存在的正间隙。
- 小尺寸对象、零宽/零高路径、负坐标、粗描边、剪切群组和嵌套群组都应纳入验证。
- 自动化模拟测试不能替代 Illustrator 中的文本度量、图层锁定、撤销与大画布实测。
