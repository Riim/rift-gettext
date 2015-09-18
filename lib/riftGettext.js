var path = require('path');

var babel = require('babel-core');
var gettextParser = require('gettext-parser');

var walker = require('./walker');

var reEscapableChars = /([?+|$(){}[^.\-\]\/\\*])/g;

function escapeRegExp(str) {
	return str.replace(reEscapableChars, '\\$1');
}

function isStringLiteral(node) {
	return node.type == 'Literal' && typeof node.value == 'string';
}

function isStringConcatExpr(node) {
	var left = node.left;
	var right = node.right;

	return node.type == 'BinaryExpression' && node.operator == '+' && (
		(isStringLiteral(left) || isStringConcatExpr(left)) &&
			(isStringLiteral(right) || isStringConcatExpr(right))
	);
}

function extractString(node) {
	return isStringLiteral(node) ? node.value : extractString(node.left) + extractString(node.right);
}

function getTranslatable(node, fnNames) {
	if (!node.arguments) {
		return null;
	}

	var callee = node.callee;
	var calleeName = callee.name;
	var firstArg = node.arguments[0];
	var secondArg = node.arguments[1];
	var thirdArg = node.arguments[2];

	if (!calleeName) {
		if (callee.type != 'MemberExpression') {
			return null;
		}

		if (callee.property.name == 'call') {
			var prop = callee.object.property;

			calleeName = callee.object.name || prop && (prop.name || prop.value);

			firstArg = node.arguments[1];
			secondArg = node.arguments[2];
			thirdArg = node.arguments[3];
		} else {
			calleeName = callee.property.name;
		}
	}

	if (firstArg && (isStringLiteral(firstArg) || isStringConcatExpr(firstArg))) {
		firstArg = extractString(firstArg);

		if (calleeName == fnNames.gettext) {
			return {
				context: '',
				str: firstArg,
				plural: undefined
			};
		}

		if (secondArg && (isStringLiteral(secondArg) || isStringConcatExpr(secondArg))) {
			secondArg = extractString(secondArg);

			if (calleeName == fnNames.ngettext) {
				return {
					context: '',
					str: firstArg,
					plural: secondArg
				};
			}

			if (calleeName == fnNames.pgettext) {
				return {
					context: firstArg,
					str: secondArg,
					plural: undefined
				};
			}

			if (thirdArg && (isStringLiteral(thirdArg) || isStringConcatExpr(thirdArg))) {
				return {
					context: firstArg,
					str: secondArg,
					plural: extractString(thirdArg)
				};
			}
		}
	}

	return null;
}

function parse(sources, opts) {
	if (!opts) {
		opts = {};
	}

	var commentPrefix = opts.commentPrefix || 'L10n:';
	var fnNames = opts.fnNames || {
		gettext: 'gettext',
		ngettext: 'ngettext',
		pgettext: 'pgettext',
		npgettext: 'npgettext'
	};

	var reInsert = RegExp(
		'\\{\\{(?:=(\\s*(' + fnNames.gettext + '|' + fnNames.ngettext + '|' + fnNames.pgettext + '|' +
			fnNames.npgettext + ')(?:\\s+(\\S[\\s\\S]*?))??\\s*)|\\/\\/([\\s\\S]*?))\\}\\}'
	);
	var reComment = RegExp('^(?:\\/|\\s*' + escapeRegExp(commentPrefix) + ')\\s*(\\S[\\s\\S]*?)\\s*$');

	var pluralMsgStr = (new Array((opts.pluralFormCount || 2) + 1))
		.join('.')
		.split('')
		.map(function() { return ''; });

	var poJSON;

	if (opts.existingPO) {
		poJSON = gettextParser.po.parse(opts.existingPO);
	} else {
		poJSON = {
			charset: 'utf-8',

			headers: {
				'project-id-version': opts.projectIdVersion || 'PACKAGE VERSION',
				'report-msgid-bugs-to': opts.reportBugsTo,
				'pot-creation-date': '',
				'po-revision-date': 'YEAR-MO-DA HO:MI+ZONE',
				'language-team': 'LANGUAGE <ll@li.org>',
				'language': opts.language || '',
				'mime-version': '1.0',
				'content-type': 'text/plain; charset=utf-8',
				'content-transfer-encoding': '8bit'
			},

			translations: {}
		};
	}

	poJSON.headers['pot-creation-date'] = new Date().toISOString()
		.replace('T', ' ')
		.replace(/:\d{2}.\d{3}Z/, '+0000');

	var translations = poJSON.translations;

	if (opts.existingPO) {
		Object.keys(translations).forEach(function(context) {
			var trnsls = translations[context];

			Object.keys(trnsls).forEach(function(msgid) {
				trnsls[msgid].comments = {
					extracted: '',
					reference: ''
				};
			});
		});
	}

	function templateToJS(tmpl) {
		var js = [];

		tmpl = tmpl.split(reInsert);

		for (var i = 0, l = tmpl.length; i < l;) {
			if (i % 5) {
				if (tmpl[i]) {
					var params = tmpl[i + 2];

					if (params) {
						js.push(tmpl[i + 1] + '(' + params + ');');
					}

					js.push(tmpl[i].replace(/[^\r\n]+/g, '1;'));
				} else {
					js.push('/* ' + tmpl[i + 3].trim().replace(/^\//, commentPrefix + ' ') + ' */');
				}

				i += 4;
			} else {
				js.push(tmpl[i].replace(/[^\r\n]+/g, '1;'));
				i++;
			}
		}

		return js.join('');
	}

	Object.keys(sources).forEach(function(file) {
		var source = sources[file];

		if (path.extname(file) == '.rtt') {
			source = templateToJS(source);
		}

		var comments = [];
		var ast = babel.parse(source);

		walker.walk(ast, {
			enter: function(node) {
				if (node.leadingComments) {
					node.leadingComments.forEach(function(comment) {
						if (reComment.test(comment.value)) {
							comments.push({
								line: comment.loc.start.line,
								column: comment.loc.start.column,
								value: RegExp.$1,
								used: false
							});
						}
					});
				}
			}
		});

		function findComments(line) {
			var prevCommentLine = 0;
			var foundComments = [];

			for (var i = comments.length; i;) {
				var comment = comments[--i];
				var commentLine = comment.line;

				if (
					!comment.used
						&& (commentLine == line || commentLine == line - 1 || commentLine == prevCommentLine - 1)
				) {
					foundComments.unshift(comment.value);
					comment.used = true;
					prevCommentLine = commentLine;
				} else if (prevCommentLine) {
					break;
				}
			}

			return foundComments.join('\n');
		}

		walker.walk(ast, {
			enter: function(node) {
				if (node.type == 'CallExpression') {
					var translatable = getTranslatable(node, fnNames);

					if (!translatable) {
						return;
					}

					var line = node.loc.start.line;
					var comments = findComments(line);
					var ref = file + ':' + line;

					var context = translatable.context;
					var str = translatable.str;

					var trnsls = translations[context] || (translations[context] = {});
					var trnsl = trnsls[str];

					if (trnsl) {
						if (comments) {
							trnsl.comments.extracted += '\n' + comments;
						}

						trnsl.comments.reference += '\n' + ref;

						if (trnsl.msgid_plural === undefined && translatable.plural !== undefined) {
							trnsl.msgid_plural = translatable.plural;

							var oldMsgstr = trnsl.msgstr;

							trnsl.msgstr = pluralMsgStr.slice();
							trnsl.msgstr[0] = oldMsgstr;
						}
					} else {
						trnsl = trnsls[str] = {
							comments: {
								extracted: comments,
								reference: ref
							},

							msgctxt: context,
							msgid: str,
							msgstr: ''
						};

						if (translatable.plural !== undefined) {
							trnsl.msgid_plural = translatable.plural;
							trnsl.msgstr = pluralMsgStr.slice();
						}
					}
				}
			}
		});

		function dedupe(item, i, arr) {
			return item && arr.indexOf(item) == i;
		}

		Object.keys(translations).forEach(function(context) {
			var trnsls = translations[context];

			Object.keys(trnsls).forEach(function(msgid) {
				var comments = trnsls[msgid].comments;

				if (comments.reference) {
					comments.reference = comments.reference.split('\n').filter(dedupe).join('\n');
				}
				if (comments.extracted) {
					comments.extracted = comments.extracted.split('\n').filter(dedupe).join('\n');
				}
			});
		});
	});

	return poJSON;
}

exports.parse = parse;

function generate(sources, opts) {
	return gettextParser.po.compile(parse(sources, opts)).toString();
}

exports.generate = generate;
