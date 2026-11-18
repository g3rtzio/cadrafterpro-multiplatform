import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ExtractPagesDialog } from './extract-pages-dialog';

describe('ExtractPagesDialog', () => {
  let component: ExtractPagesDialog;
  let fixture: ComponentFixture<ExtractPagesDialog>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ExtractPagesDialog],
    }).compileComponents();

    fixture = TestBed.createComponent(ExtractPagesDialog);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
