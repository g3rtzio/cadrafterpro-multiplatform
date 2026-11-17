import { ComponentFixture, TestBed } from '@angular/core/testing';
import { SlipSheetDialog } from './slip-sheet-dialog';

describe('SlipSheetDialog', () => {
  let component: SlipSheetDialog;
  let fixture: ComponentFixture<SlipSheetDialog>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SlipSheetDialog],
    }).compileComponents();

    fixture = TestBed.createComponent(SlipSheetDialog);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
