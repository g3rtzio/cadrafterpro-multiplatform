import { ComponentFixture, TestBed } from '@angular/core/testing';
import { OcrPanel } from './ocr-panel';

describe('OcrPanel', () => {
  let component: OcrPanel;
  let fixture: ComponentFixture<OcrPanel>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [OcrPanel],
    }).compileComponents();

    fixture = TestBed.createComponent(OcrPanel);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
