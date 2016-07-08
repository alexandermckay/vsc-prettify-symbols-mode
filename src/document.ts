import * as vscode from 'vscode';
import {Substitution, UglyRevelation, LanguageEntry, PrettyCursor} from './configuration';
import * as pos from './position';
import {DisjointRangeSet} from './disjointrangeset';
import * as drangeset from './disjointrangeset';

const debugging = false;
const activeEditorDecorationTimeout = 20;
const inactiveEditorDecorationTimeout = 200;

interface PrettySubstitution {
	ugly: RegExp,
	pretty: string,
	decorationType: vscode.TextEditorDecorationType,
	ranges: DisjointRangeSet;
}

function arrayEqual<T>(a1: T[], a2: T[], isEqual: (x:T,y:T)=>boolean = ((x,y) => x==y)) : boolean {
  if(a1.length!=a2.length)
    return false;
  for(let idx = 0; idx < a1.length; ++idx) {
    if(!isEqual(a1[idx],a2[idx]))
      return false;
  }
  return true;
}

export class PrettyDocumentController implements vscode.Disposable {
  private document: vscode.TextDocument;
  private prettyDecorations : PrettySubstitution[] = [];
  private prettySubstitutions : Substitution[] = [];  
  private uglyAll = new RegExp("","g");
  private uglyDecorationRanges = new DisjointRangeSet();
  private subscriptions : vscode.Disposable[] = [];
  private changedUglies = false; // flag used to determine if the uglies have been updated
  private revealStrategy : UglyRevelation;
  private adjustCursorMovement : boolean;
  private prettyCursor: PrettyCursor;

  // hides a "ugly" decorations
  private uglyDecoration: vscode.TextEditorDecorationType = vscode.window.createTextEditorDecorationType({
		// color: "black; font-size: 0pt", // for some reason, the cursor disappears if the font is too small or display:none
    // The font size must be nonzero so that the (subchild) pretty text can scale it up by 1000em
    textDecoration: 'none; font-size: 0.001em',
  });
  // reveals the "ugly" decorations; is applied on top of uglyDecoration and should take priority
  private revealedUglyDecoration: vscode.TextEditorDecorationType = vscode.window.createTextEditorDecorationType({
    textDecoration: 'none; font-size: inherit !important',
    before: {
      textDecoration: 'none; font-size: 0pt',
    }
  });
  // draws a box around a pretty symbol
  private boxedSymbolDecoration: vscode.TextEditorDecorationType = vscode.window.createTextEditorDecorationType({
    before: {
      border: '0.1em solid',
      margin: '-0em -0.05em -0em -0.1em',
    }
  });

  constructor(doc: vscode.TextDocument, settings: LanguageEntry) {
    this.document = doc;
    this.prettySubstitutions = settings.substitutions;
    this.revealStrategy = settings.revealOn;
    this.adjustCursorMovement = settings.adjustCursorMovement;
    this.prettyCursor = settings.prettyCursor;
    this.loadDecorations();

    // Parse whole document
    const docRange = new vscode.Range(0,0,this.document.lineCount,0);
    this.parsePretty(docRange);
    this.applyDecorations(this.getEditors());

    this.subscriptions.push(this.uglyDecoration);
    this.subscriptions.push(this.revealedUglyDecoration);
    this.subscriptions.push(this.boxedSymbolDecoration);
    this.subscriptions.push(vscode.workspace.onDidChangeTextDocument((e) => {
      if(e.document == this.document)
        this.onChangeDocument(e);
    }));
  }

  public dispose() {
    this.unloadDecorations();
    this.debugDecorations.forEach((val) => val.dec.dispose());
    this.subscriptions.forEach((s) => s.dispose());
  }

  private getEditors() {
    return vscode.window.visibleTextEditors
      .filter((editor) => {
        return editor.document == this.document;
      });
  }

  private unloadDecorations() {
    this.uglyDecorationRanges = new DisjointRangeSet();
    for(const subst of this.prettyDecorations) {
      subst.ranges = new DisjointRangeSet();
    }
    this.debugDecorations.forEach((val) => val.ranges = []);

    this.applyDecorations(this.getEditors());

    for(const oldDecoration of this.prettyDecorations) {
      oldDecoration.decorationType.dispose();
    }

  }

  private regexpOptionalGroup(re: string) {
    if(re)
      return `(?:${re})`;
    else
      return "";
  }

  private loadDecorations() {
    this.unloadDecorations();
    this.prettyDecorations = [];
    const uglyAllStrings = [];
    for(const prettySubst of this.prettySubstitutions) {
      const uglyStr = this.regexpOptionalGroup(prettySubst.pre) + "(" + prettySubst.ugly + ")" + this.regexpOptionalGroup(prettySubst.post);
      try {
        this.prettyDecorations.push({
          ugly: new RegExp(uglyStr,"g"),
          pretty: prettySubst.pretty,
          ranges: new DisjointRangeSet(),
          decorationType: vscode.window.createTextEditorDecorationType({
            before: {
              contentText: prettySubst.pretty,
              textDecoration: 'none; font-size: 1000em',
            },
          }),
        });
        uglyAllStrings.push(`(?:${uglyStr})`);
      } catch(e) {
        console.warn(`Could not add rule "${uglyStr}" --> "${prettySubst.pretty}"; invalid regular expression`)
      }
    }
    this.uglyAll = new RegExp(uglyAllStrings.join('|'), 'g');
  }

  private applyDecorationsTimeout = undefined;
  private applyDecorationsTimeoutActive = undefined;
  private applyDecorations(editors: Iterable<vscode.TextEditor>) {
    // settings many decorations is pretty slow, so only call this at most ~20ms
    if(!this.applyDecorationsTimeoutActive) {
      this.applyDecorationsTimeoutActive = setTimeout(() => {
        for(const editor of editors) {
          if(editor !== vscode.window.activeTextEditor)
            break; // handle ONLY the active editr here
          editor.setDecorations(this.uglyDecoration,this.uglyDecorationRanges.getRanges());
          for(const subst of this.prettyDecorations) {
            editor.setDecorations(subst.decorationType,subst.ranges.getRanges());
          }
          if(debugging)
            this.debugDecorations.forEach((val) => editor.setDecorations(val.dec,val.ranges));
        }	
        this.applyDecorationsTimeoutActive = undefined;
      }, activeEditorDecorationTimeout);
    }
    if(!this.applyDecorationsTimeout) {
      this.applyDecorationsTimeout = setTimeout(() => {
        for(const editor of editors) {
          if(editor === vscode.window.activeTextEditor)
            break; // handle this in another timer
          editor.setDecorations(this.uglyDecoration,this.uglyDecorationRanges.getRanges());
          for(const subst of this.prettyDecorations) {
            editor.setDecorations(subst.decorationType,subst.ranges.getRanges());
          }
          if(debugging)
            this.debugDecorations.forEach((val) => editor.setDecorations(val.dec,val.ranges));
        }	
        this.applyDecorationsTimeout = undefined;
      }, inactiveEditorDecorationTimeout);
    }
  }

  // helper function to determine which ugly has been matched
  private getUglyFromMatch(match: RegExpExecArray, line: number) {
    const matches = match
      .map((value,idx) => ({index:idx,match:value}))
      .filter((value) => value.match !== undefined);
    if(matches.length <= 1)
      return undefined;
    const matchIdx = matches[matches.length-1].index;
    const matchStr = match[matchIdx];
    const start = match.index + match[0].indexOf(matchStr);
    const end = start + matchStr.length;
    const uglyRange = new vscode.Range(line,start,line,end);

    // continue the search at the end of the ugly bit; not the whole match
    this.uglyAll.lastIndex = end;

    return {range: uglyRange, prettyIndex: matchIdx-1};
  }


  /**
   * Assumes that all decorations overlapping the range have been removed
   * However, parsing may continue to the end of the line of range.end,
   * so more pre-existing ranges may be removed from uglyDecorationRanges
   * returns the range of reparsed text
   */
  private parsePretty(range: vscode.Range) {
    if(this.prettyDecorations.length == 0)
      return range;
    range = this.document.validateRange(range);

    const newUglyRanges = new DisjointRangeSet();
    const newPrettyRanges = [];
    this.prettyDecorations.forEach(() => newPrettyRanges.push(new DisjointRangeSet()));

    // only start looking for ugly strings after the last preexisting ugly string or else at the beginning of the line
    this.uglyAll.lastIndex = 0;
    const precedingRange = this.uglyDecorationRanges.findPreceding(range.start);
    if(precedingRange && precedingRange.end.line==range.start.line)
      this.uglyAll.lastIndex = precedingRange.end.character;
    const startCharacter = this.uglyAll.lastIndex;

    // parse all but the last line
    for(let idx = range.start.line; idx < range.end.line; ++idx) {
      const line = this.document.lineAt(idx);
      let match : RegExpExecArray;
      while(match = this.uglyAll.exec(line.text)) {
        const ugly = this.getUglyFromMatch(match, idx);
        if(!ugly)
          continue;
        newUglyRanges.insert(ugly.range);
        newPrettyRanges[ugly.prettyIndex].insert(ugly.range);
      }
      // next search starts at the beginning of the line
      this.uglyAll.lastIndex = 0;
    }

    // handle the last line with special care because it might require
    // re-parsing between range.end and the end of the line.
    const line = this.document.lineAt(range.end.line);
    const preexistingUgliesIter = this.uglyDecorationRanges.getRangesStartingAt(range.end);
    let preexistingUgly = preexistingUgliesIter.next();
    let match : RegExpExecArray;    
    // match up the the last character of the line
    while(match = this.uglyAll.exec(line.text)) {
      try {
        const ugly = this.getUglyFromMatch(match, range.end.line);
        if(!ugly)
          continue;
        // if we have just matched a preexisting ugly, then we are done
        if(!preexistingUgly.done && preexistingUgly.value.isEqual(ugly.range))
          break;
        else if(!preexistingUgly.done && preexistingUgly.value.start.isBefore(ugly.range.end))
          preexistingUgly = preexistingUgliesIter.next();

        newUglyRanges.insert(ugly.range);
        newPrettyRanges[ugly.prettyIndex].insert(ugly.range);
      } catch(e) {}
    }

    // remove any freshly discarded uglies: from range.end to the last new ugly position
    if(range.end.isBefore(newUglyRanges.getEnd())) {
      const extraOverlap = new vscode.Range(range.end,newUglyRanges.getEnd());
      this.uglyDecorationRanges.removeOverlapping(extraOverlap);
      for(const subst of this.prettyDecorations)
        subst.ranges.removeOverlapping(extraOverlap);
    }

    // add the new pretties & ugly ducklings
    this.uglyDecorationRanges.insertRanges(newUglyRanges);
    this.prettyDecorations.forEach((pretty,idx) => pretty.ranges.insertRanges(newPrettyRanges[idx]));

    if(!newUglyRanges.isEmpty()) {
      this.changedUglies = true;
      return new vscode.Range(range.start.with({character: startCharacter}),drangeset.maxPosition(range.end,newUglyRanges.getEnd()));
    } else
      return new vscode.Range(range.start.with({character: startCharacter}),range.end);
  }

  private debugDecorations : {dec:vscode.TextEditorDecorationType, ranges: vscode.Range[]}[] = 
    [ {dec: vscode.window.createTextEditorDecorationType({textDecoration: 'line-through'}), ranges: []} // affected uglies
  	, {dec: vscode.window.createTextEditorDecorationType({backgroundColor: 'yellow',}), ranges: []} // reparsed text
    , {dec: vscode.window.createTextEditorDecorationType({outlineColor: 'black', outlineStyle: 'solid', outlineWidth: '1pt'}), ranges: []} // editRange
    ];

  private onChangeDocument(event: vscode.TextDocumentChangeEvent) {
    // this.cachedLines = [];
    if(debugging)
      this.debugDecorations.forEach((val) => val.ranges = []);
    // const startTime = new Date().getTime();
    this.changedUglies = false; // assume no changes need to be made for now
    for(const change of event.contentChanges) {
      try {
      const delta = drangeset.toRangeDelta(change.range, change.text);
      const editRange = drangeset.rangeDeltaNewRange(delta);

      const removed  = this.uglyDecorationRanges.removeOverlapping(change.range,{includeTouchingStart:true,includeTouchingEnd:true});
      const affected = this.uglyDecorationRanges.shiftRangeDelta(delta);
      if(removed.length > 0)
        this.changedUglies = true;

      for(const subst of this.prettyDecorations) {
        subst.ranges.removeOverlapping(change.range,{includeTouchingStart:true,includeTouchingEnd:true});
        subst.ranges.shiftRangeDelta(delta);
      }

      const reparsed = this.parsePretty(editRange);

      if(debugging) {
        this.debugDecorations[0].ranges.push(affected);
        this.debugDecorations[1].ranges.push(reparsed);
        this.debugDecorations[2].ranges.push(editRange);
      }
      } catch(e) {
        console.error(e);
      }
    }

    if(this.changedUglies || true)
      this.applyDecorations(this.getEditors());
    else if(debugging)
      this.debugDecorations.forEach((val) => this.getEditors().forEach((e) => e.setDecorations(val.dec,val.ranges))); 
    
    // this.refresh();
    // const endTime = new Date().getTime();
    // console.log(endTime - startTime + "ms")
  }

  /** reparses the document and recreates the highlights for all editors */  
  public refresh() {
    this.uglyDecorationRanges = new DisjointRangeSet();
    for(const subst of this.prettyDecorations) {
      subst.ranges = new DisjointRangeSet();
    }
    this.debugDecorations.forEach((val) => val.ranges = [])
    // this.applyDecorations(this.getEditors());

    const docRange = new vscode.Range(0,0,this.document.lineCount,0);
    this.parsePretty(docRange);

    this.applyDecorations(this.getEditors()); 
  }

  private findSymbolAt(pos: vscode.Position, options: {excludeStart?: boolean, includeEnd?: boolean} = {excludeStart: false, includeEnd: false}) {
    return this.uglyDecorationRanges.find(pos,options);
  }

  private findSymbolsIn(range: vscode.Range) {
    return this.uglyDecorationRanges.getOverlap(range);
  }

  private revealSelections(editor: vscode.TextEditor) {
    const revealUgly = (getRange: (sel:vscode.Selection) => vscode.Range) => {
      const cursorRevealedRanges = new DisjointRangeSet();
      for(const selection of editor.selections) {
        const ugly = getRange(selection);
        if(ugly)
          cursorRevealedRanges.insert(ugly);
      }
      // reveal the uglies and hide the pretties
      editor.setDecorations(this.revealedUglyDecoration, cursorRevealedRanges.getRanges());
    }
    const revealUglies = (getRanges: (sel:vscode.Selection) => DisjointRangeSet) => {
      const cursorRevealedRanges = new DisjointRangeSet();
      for(const selection of editor.selections) {
        const ugly = getRanges(selection);
        if(ugly)
          cursorRevealedRanges.insertRanges(ugly);
      }
      // reveal the uglies and hide the pretties
      editor.setDecorations(this.revealedUglyDecoration, cursorRevealedRanges.getRanges());
    }

    // add the new intersections
    switch(this.revealStrategy) {
      case 'cursor':
        revealUgly((sel) => this.findSymbolAt(sel.active,{includeEnd: true}));
        return;
      case 'cursor-inside':
        revealUgly((sel) => this.findSymbolAt(sel.active,{excludeStart: true}));
        return;
      case 'active-line':
        revealUglies((sel) => this.findSymbolsIn(editor.document.lineAt(sel.active.line).range));
        return;
      case 'selection':
        revealUglies((sel) => this.findSymbolsIn(new vscode.Range(sel.start, sel.end)));
        return;
    }
 }


  private lastSelections = new Map<vscode.TextEditor, vscode.Selection[]>();
  public adjustCursor(editor: vscode.TextEditor) {
    let updated = false;
    let adjustedSelections : vscode.Selection[] = [];
    let before = this.lastSelections.get(editor);
    if(!before) {
      this.lastSelections.set(editor,editor.selections);
      return;
    }
    const after = editor.selections;
    if(arrayEqual(before,after))
      return;

    after.forEach((sel,idx) => {
      if(before[idx] === undefined) {
        adjustedSelections.push(new vscode.Selection(sel.anchor,sel.active));
        return;
      }
      const adjusted = pos.adjustCursorMovement(before[idx].active,sel.active,this.document,this.uglyDecorationRanges.getRanges());
      if(!adjusted.pos.isEqual(sel.active)) {
        updated = true;
      }

      // if anchor==active, then adjust both; otherwise just adjust the active position
      if(sel.anchor.isEqual(sel.active))
        adjustedSelections.push(new vscode.Selection(adjusted.pos,adjusted.pos));
      else
        adjustedSelections.push(new vscode.Selection(sel.anchor,adjusted.pos));
    });

    this.lastSelections.set(editor,adjustedSelections);

    // could cause this method to be called again, but since we've set the
    // last-selection to adjustedSelections, we will immediately return. 
    if(updated)
      editor.selections = adjustedSelections;
  }

  private renderPrettyCursor(editor: vscode.TextEditor) {
    switch(this.prettyCursor) {
      case 'boxed': {
        const boxPretty = (getRange: (sel:vscode.Selection) => vscode.Range) => {
          const cursorBoxRanges = new DisjointRangeSet();
          for(const selection of editor.selections) {
            const pretty = getRange(selection);
            if(pretty)
              cursorBoxRanges.insert(pretty);
          }
          // reveal the uglies and hide the pretties
          editor.setDecorations(this.boxedSymbolDecoration, cursorBoxRanges.getRanges());
        }
        boxPretty((sel) => this.findSymbolAt(sel.active));
        return;
      }
      default:
        return;
    }
  }

  public selectionChanged(editor: vscode.TextEditor) {
    this.revealSelections(editor);
    this.renderPrettyCursor(editor);
    if(this.adjustCursorMovement)
      this.adjustCursor(editor);
  }

}